// @vitest-environment node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

import type { NmrPredictionResult } from "../domain/contracts";
import {
  nmrPredictCarbonCommandId,
  nmrPredictFluorineCommandId,
  nmrPredictPhosphorusCommandId,
  nmrPredictProtonCommandId
} from "../manifest";
import { F19_HOSE_TABLE } from "../providers/gnn/modelRelease";
import { PHOSPHORUS_MEASURED_ACCURACY } from "../providers/ocl/measuredAccuracy";
import { describePackageArtifact, extractPackageArtifact } from "./packageArtifact";

interface WorkerMessage {
  kind: string;
  [key: string]: unknown;
}

describePackageArtifact("packaged plugin entry, loaded and run for real", (artifact) => {
  it.each([
    { nucleus: "13C", commandId: nmrPredictCarbonCommandId, smiles: "Cc1ccccc1", count: 5, method: "GNN prediction", source: "model", model: "13C" },
    { nucleus: "1H", commandId: nmrPredictProtonCommandId, smiles: "Cc1ccccc1", count: 4, method: "GNN prediction", source: "model", model: "1H" },
    { nucleus: "31P", commandId: nmrPredictPhosphorusCommandId, smiles: "CCP(CC)CC", count: 1, method: "HOSE lookup", source: "lookup", model: undefined },
    { nucleus: "19F", commandId: nmrPredictFluorineCommandId, smiles: "FC(F)(F)c1ccccc1", count: 1, method: "GNN prediction", source: "model", model: "19F" }
  ])("predicts $nucleus shifts through the built package", async ({ nucleus, commandId, smiles, count, method, source, model }) => {
    // Execute each command to verify each reference table and each GNN model survives bundling and
    // ZIP extraction. In Node, `typeof Worker === "undefined"`, so entry.js's own fallback path runs:
    // the in-thread predictor (GNN first, HOSE fallback), lazily imported as its own chunk — the same
    // runtime code a host without nested-worker support would take. This shim plays the *host* side of
    // runPluginWorker's postMessage protocol: no real Worker thread is spawned, but the worker-side code
    // (entry.js, the predictor chunk, the ONNX Runtime chunk, its WebAssembly binary and loader, the
    // model files, and the resources JSON) is the genuine built output, imported and executed.
    const outbox: WorkerMessage[] = [];
    let onMessage: ((event: { data: WorkerMessage }) => void) | undefined;

    const g = globalThis as unknown as {
      postMessage?: (message: WorkerMessage) => void;
      addEventListener?: (type: string, cb: (event: { data: WorkerMessage }) => void) => void;
      removeEventListener?: (type: string, cb: (event: { data: WorkerMessage }) => void) => void;
    };
    const previous = { postMessage: g.postMessage, addEventListener: g.addEventListener, removeEventListener: g.removeEventListener };
    // The worker fetches its bundled GNN model files relative to the package. A host serves them over
    // its own URL scheme; here they are file: URLs, which this shim reads from the extracted package.
    const previousFetch = globalThis.fetch;
    // In Node, ONNX Runtime Web's Emscripten loader sets `global.Worker` to worker_threads' Worker.
    // Restore it so the next case's entry.js still takes the in-thread path.
    const hadWorker = "Worker" in globalThis;
    const previousWorker = (globalThis as { Worker?: unknown }).Worker;
    const fetchedModels: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.protocol !== "file:") return previousFetch(input, init);
      if (url.pathname.endsWith(".onnx")) fetchedModels.push(url.pathname.split("/").pop() ?? "");
      return new Response(await readFile(url));
    }) as typeof fetch;
    g.postMessage = (message) => outbox.push(message);
    g.addEventListener = (type, cb) => {
      if (type === "message") onMessage = cb;
    };
    g.removeEventListener = () => undefined;

    const send = (message: WorkerMessage): void => onMessage?.({ data: message });
    const drain = async (): Promise<WorkerMessage[]> => {
      // Let queued microtasks and dynamic imports (the lazily-loaded predictor chunk is real disk
      // I/O) resolve, then hand back and clear whatever entry.js posted.
      for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      return outbox.splice(0, outbox.length);
    };

    const { directory, cleanup } = extractPackageArtifact(artifact);
    const entryPath = join(directory, "entry.js");
    try {
      await import(pathToFileURL(entryPath).href);

      const ready = (await drain()).find((message) => message.kind === "ready");
      expect(ready).toBeDefined();
      // No model is loaded at plugin start.
      expect(fetchedModels).toEqual([]);

      send({ kind: "invokeCommand", commandRequestId: "req-1", commandId });

      let settled: WorkerMessage | undefined;
      // The first ¹H/¹³C command also loads its model and the WebAssembly runtime.
      for (let round = 0; round < 150 && !settled; round += 1) {
        const posted = await drain();
        for (const message of posted) {
          if (message.kind === "commandSettled" && message.commandRequestId === "req-1") {
            settled = message;
            continue;
          }
          if (message.kind !== "capabilityRequest") continue;
          const { requestId, namespace, method } = message as WorkerMessage & { requestId: number; namespace: string; method: string };
          const value =
            namespace === "selection" && method === "getSelection"
              ? {
                  objectIds: ["molecule-1"],
                  molecules: [
                    {
                      objectId: "molecule-1",
                      documentId: "doc-1",
                      pageId: "page-1",
                      structureFormat: "smiles",
                      structure: smiles,
                      sourceFingerprint: "fixture"
                    }
                  ]
                }
              : undefined; // panels.showReport / analysis.write: fire-and-forget, any resolved value is fine
          send({ kind: "capabilityResult", requestId, ok: true, value });
        }
      }

      expect(settled).toBeDefined();
      const commandResult = (settled as WorkerMessage & { value: { ok: boolean; data?: NmrPredictionResult } }).value;
      expect(commandResult.ok).toBe(true);
      expect(commandResult.data?.resonances).toHaveLength(count);
      expect(commandResult.data?.resonances).toEqual(
        Array.from({ length: count }, () => expect.objectContaining({ nucleus, source, method }))
      );
      // Exactly the requested nucleus's model was loaded, and only for ¹H/¹³C/¹⁹F.
      expect(fetchedModels.map((file) => file.split(".")[0])).toEqual(model ? [model] : []);
      if (nucleus === "31P") {
        expect(commandResult.data?.backend.dataChecksum).toBe(PHOSPHORUS_MEASURED_ACCURACY.corpusSha256);
      }
      if (nucleus === "19F") {
        // The ¹⁹F table chunk survived bundling: its own input checksum came back with the result.
        expect(commandResult.data?.backend.dataChecksum).toBe(F19_HOSE_TABLE.inputSha256);
      }
    } finally {
      g.postMessage = previous.postMessage;
      g.addEventListener = previous.addEventListener;
      g.removeEventListener = previous.removeEventListener;
      globalThis.fetch = previousFetch;
      if (hadWorker) (globalThis as { Worker?: unknown }).Worker = previousWorker;
      else delete (globalThis as { Worker?: unknown }).Worker;
      cleanup();
    }
  }, 60000);
});
