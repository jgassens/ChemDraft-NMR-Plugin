// @vitest-environment node
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

import { nmrPredictCarbonCommandId } from "../manifest";
import { describePackageArtifact, extractPackageArtifact } from "./packageArtifact";

interface WorkerMessage {
  kind: string;
  [key: string]: unknown;
}

describePackageArtifact("packaged plugin entry, loaded and run for real", (artifact) => {
  it("predicts toluene's 5 distinct resonances (13C) through the built package", async () => {
    // Loads a real 6MB predictor chunk and 1.3MB reference-data JSON from disk, then runs an actual
    // HOSE-fragment prediction, comfortably past vitest's 5s default under any normal machine load.
    // In Node, `typeof Worker === "undefined"`, so entry.js's own fallback path runs: the in-thread OCL
    // predictor, lazily imported as its own chunk — the same runtime code a host without nested-worker
    // support would take. This shim plays the *host* side of runPluginWorker's postMessage protocol: no
    // real Worker thread is spawned, but the worker-side code (entry.js, the OCL predictor chunk, and
    // the resources JSON this task deduplicates) is the genuine built output, imported and executed.
    const outbox: WorkerMessage[] = [];
    let onMessage: ((event: { data: WorkerMessage }) => void) | undefined;

    const g = globalThis as unknown as {
      postMessage?: (message: WorkerMessage) => void;
      addEventListener?: (type: string, cb: (event: { data: WorkerMessage }) => void) => void;
      removeEventListener?: (type: string, cb: (event: { data: WorkerMessage }) => void) => void;
    };
    const previous = { postMessage: g.postMessage, addEventListener: g.addEventListener, removeEventListener: g.removeEventListener };
    g.postMessage = (message) => outbox.push(message);
    g.addEventListener = (type, cb) => {
      if (type === "message") onMessage = cb;
    };
    g.removeEventListener = () => undefined;

    const send = (message: WorkerMessage): void => onMessage?.({ data: message });
    const drain = async (): Promise<WorkerMessage[]> => {
      // Let queued microtasks and dynamic imports (the lazily-loaded OCL predictor chunk is real disk
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

      send({ kind: "invokeCommand", commandRequestId: "req-1", commandId: nmrPredictCarbonCommandId });

      let settled: WorkerMessage | undefined;
      for (let round = 0; round < 20 && !settled; round += 1) {
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
                  objectIds: ["toluene-1"],
                  molecules: [
                    {
                      objectId: "toluene-1",
                      documentId: "doc-1",
                      pageId: "page-1",
                      structureFormat: "smiles",
                      structure: "Cc1ccccc1",
                      sourceFingerprint: "toluene-fixture"
                    }
                  ]
                }
              : undefined; // panels.showReport / analysis.write: fire-and-forget, any resolved value is fine
          send({ kind: "capabilityResult", requestId, ok: true, value });
        }
      }

      expect(settled).toBeDefined();
      const commandResult = (settled as WorkerMessage & { value: { ok: boolean; data?: { resonances: unknown[] } } }).value;
      expect(commandResult.ok).toBe(true);
      expect(commandResult.data?.resonances).toHaveLength(5);
    } finally {
      g.postMessage = previous.postMessage;
      g.addEventListener = previous.addEventListener;
      g.removeEventListener = previous.removeEventListener;
      cleanup();
    }
  }, 20000);
});
