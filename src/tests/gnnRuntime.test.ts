// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { afterAll, describe, expect, it, vi } from "vitest";

import packageJson from "../../package.json" with { type: "json" };
import { GNN_MODEL_FILES, GNN_TRAINING_DOMAIN_SHA256, type GnnNucleus } from "../providers/gnn/modelRelease";
import {
  bundledModelUrl,
  bundledRuntimeUrls,
  GnnModelRuntime,
  ONNX_RUNTIME_WEB_VERSION,
  type GnnModelState,
  type OrtModuleLike
} from "../providers/gnn/runtime";
import { packGnnInputs, type GnnInputTensors } from "../providers/gnn/tensors";
import type { GnnMoleculeFeatures } from "../providers/gnn/featurize";
import { GNN_TRAINING_DOMAIN } from "../providers/gnn/trainingDomain";
import {
  GNN_ALLOWED_ISOTOPES,
  GNN_CHARGE_STATE_MIN,
  GNN_DOMAIN_MARGIN,
  GNN_ELEMENT_MIN
} from "../providers/gnn/domainRules";
import reference from "./fixtures/gnn-onnx-reference.json" with { type: "json" };

// In Node, ONNX Runtime Web's Emscripten loader sets `global.Worker` (worker_threads). Undo it so
// later test files that check for a missing Worker are unaffected.
const hadWorker = "Worker" in globalThis;
const previousWorker = (globalThis as { Worker?: unknown }).Worker;
afterAll(() => {
  if (hadWorker) (globalThis as { Worker?: unknown }).Worker = previousWorker;
  else delete (globalThis as { Worker?: unknown }).Worker;
});

/** Node reads the bundled files from disk; the plugin worker fetches them from the package. */
const readAsset = async (url: URL): Promise<Uint8Array> => new Uint8Array(await readFile(url));

interface ReferenceCase {
  latencyCase: number;
  atoms: { shape: number[]; data: number[] };
  neighbor: { shape: number[]; data: number[] };
  bonds: { shape: number[]; data: number[] };
  mask: { shape: number[]; data: number[] };
  features: Omit<GnnMoleculeFeatures, "schemaVersion">;
  expectedPpm: Record<GnnNucleus, number[]>;
}
const cases = reference.cases as unknown as ReferenceCase[];

function tensorsOf(item: ReferenceCase): GnnInputTensors {
  return {
    atomCount: item.atoms.shape[1],
    degree: item.neighbor.shape[2],
    atoms: Float32Array.from(item.atoms.data),
    neighbor: Int32Array.from(item.neighbor.data),
    bonds: Float32Array.from(item.bonds.data),
    mask: Uint8Array.from(item.mask.data)
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("bundled GNN model files", () => {
  it("match the frozen SHA-256 values and sizes", () => {
    for (const nucleus of ["1H", "13C"] as const) {
      const bytes = readFileSync(bundledModelUrl(nucleus));
      expect(bytes.byteLength).toBe(GNN_MODEL_FILES[nucleus].bytes);
      expect(sha256(bytes)).toBe(GNN_MODEL_FILES[nucleus].sha256);
    }
    expect(sha256(readFileSync(new URL("../providers/gnn/model/domain.json", import.meta.url)))).toBe(GNN_TRAINING_DOMAIN_SHA256);
  });

  it("ships the training domain with the thresholds ABSTENTION.md fixed", () => {
    expect(GNN_TRAINING_DOMAIN.schema_version).toBe("1");
    expect(GNN_TRAINING_DOMAIN.size_limit).toBe(Math.min(GNN_TRAINING_DOMAIN.heavy_atoms_p999, 500));
    expect(GNN_TRAINING_DOMAIN.thresholds).toMatchObject({
      element_min: GNN_ELEMENT_MIN,
      charge_state_min: GNN_CHARGE_STATE_MIN,
      domain_margin: GNN_DOMAIN_MARGIN,
      allowed_isotopes: [...GNN_ALLOWED_ISOTOPES],
      size_ui_limit: 500
    });
  });

  it("pins onnxruntime-web exactly and bundles its single-threaded WebAssembly build", () => {
    expect(packageJson.dependencies["onnxruntime-web"]).toBe(ONNX_RUNTIME_WEB_VERSION);
    const urls = bundledRuntimeUrls();
    expect(urls.wasm.pathname.endsWith("/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm")).toBe(true);
    expect(urls.mjs.pathname.endsWith("/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs")).toBe(true);
    expect(readFileSync(urls.wasm).byteLength).toBeGreaterThan(1_000_000);
    const installed = JSON.parse(readFileSync(new URL("../../node_modules/onnxruntime-web/package.json", import.meta.url), "utf8"));
    expect(installed.version).toBe(ONNX_RUNTIME_WEB_VERSION);
  });
});

describe("GnnModelRuntime loading", () => {
  it("does nothing until a nucleus is requested, then loads only that model, once", async () => {
    const fetchAsset = vi.fn(readAsset);
    const loadOrt = vi.fn(async () => (await import("onnxruntime-web/wasm")) as unknown as OrtModuleLike);
    const runtime = new GnnModelRuntime({ fetchAsset, loadOrt });
    expect(fetchAsset).not.toHaveBeenCalled();
    expect(loadOrt).not.toHaveBeenCalled();
    expect(runtime.requested).toEqual([]);

    const first = runtime.load("13C");
    const again = runtime.load("13C");
    expect(again).toBe(first);
    const state = await first;
    expect(state.status).toBe("ready");
    expect(fetchAsset).toHaveBeenCalledTimes(1);
    expect(fetchAsset.mock.calls[0][0].pathname.endsWith("/13C.fp16.onnx")).toBe(true);
    expect(loadOrt).toHaveBeenCalledTimes(1);
    expect(runtime.requested).toEqual(["13C"]);
  }, 60_000);

  it("treats a checksum mismatch as unavailable and never imports the runtime", async () => {
    const loadOrt = vi.fn(async (): Promise<OrtModuleLike> => {
      throw new Error("must not be called");
    });
    const tampered = new GnnModelRuntime({
      fetchAsset: async (url) => {
        const bytes = await readAsset(url);
        bytes[bytes.length - 1] ^= 0xff;
        return bytes;
      },
      loadOrt
    });
    const state = await tampered.load("1H");
    expect(state).toMatchObject({ status: "unavailable", nucleus: "1H", reason: "checksum-mismatch" });
    expect(loadOrt).not.toHaveBeenCalled();

    const wrongPin = new GnnModelRuntime({ fetchAsset: readAsset, loadOrt, expectedSha256: () => "0".repeat(64) });
    expect(await wrongPin.load("13C")).toMatchObject({ status: "unavailable", reason: "checksum-mismatch" });
    expect(loadOrt).not.toHaveBeenCalled();
  });

  it("treats a missing model file as unavailable", async () => {
    const runtime = new GnnModelRuntime({
      fetchAsset: async () => {
        throw new Error("HTTP 404");
      }
    });
    expect(await runtime.load("13C")).toMatchObject({ status: "unavailable", reason: "missing" });
  });

  it("treats a runtime that fails to load as unavailable", async () => {
    const runtime = new GnnModelRuntime({
      fetchAsset: readAsset,
      loadOrt: async () => {
        throw new Error("WebAssembly SIMD is not supported");
      }
    });
    const state = await runtime.load("1H");
    expect(state).toMatchObject({ status: "unavailable", reason: "load-failed" });
    expect((state as Extract<GnnModelState, { status: "unavailable" }>).message).toContain("SIMD");
  });

  it("configures ONNX Runtime Web for one thread, no proxy worker, and the bundled WebAssembly files", async () => {
    const real = (await import("onnxruntime-web/wasm")) as unknown as OrtModuleLike;
    const runtime = new GnnModelRuntime({ fetchAsset: readAsset, loadOrt: async () => real });
    expect((await runtime.load("1H")).status).toBe("ready");
    expect(real.env.wasm.numThreads).toBe(1);
    expect(real.env.wasm.proxy).toBe(false);
    const urls = bundledRuntimeUrls();
    expect(real.env.wasm.wasmPaths).toEqual({ mjs: urls.mjs.href, wasm: urls.wasm.href });
  }, 60_000);
});

describe("GNN tensors match the training packing", () => {
  it.each(cases.map((item) => [item.latencyCase, item] as const))(
    "latency case %i: packGnnInputs reproduces the tensors py/featurize.py packed",
    (_, item) => {
      const packed = packGnnInputs({ schemaVersion: "1", ...item.features });
      const expected = tensorsOf(item);
      expect(packed.atomCount).toBe(expected.atomCount);
      expect(packed.degree).toBe(expected.degree);
      expect(Array.from(packed.atoms)).toEqual(Array.from(expected.atoms));
      expect(Array.from(packed.neighbor)).toEqual(Array.from(expected.neighbor));
      expect(Array.from(packed.bonds)).toEqual(Array.from(expected.bonds));
      expect(Array.from(packed.mask)).toEqual(Array.from(expected.mask));
    }
  );
});

describe("GNN ONNX outputs", () => {
  // The expectations are model.py's forward pass evaluated in NumPy (float32) with the fp16-stored
  // weights read from each .onnx file, independent of ONNX Runtime. Both sides use the same fp16
  // weights, so the tolerance only absorbs float32 summation order.
  it.each(["1H", "13C"] as const)("%s: ONNX Runtime Web (WASM, one thread) matches the reference forward pass", async (nucleus) => {
    const runtime = new GnnModelRuntime({ fetchAsset: readAsset });
    const state = await runtime.load(nucleus);
    if (state.status !== "ready") throw new Error(`model unavailable: ${state.message}`);
    const tolerance = reference.tolerancePpm[nucleus];
    for (const item of cases) {
      const ppm = await state.model.run({ features: { schemaVersion: "1", ...item.features }, tensors: tensorsOf(item) });
      expect(ppm).toHaveLength(item.atoms.shape[1]);
      const worst = Math.max(...Array.from(ppm, (value, node) => Math.abs(value - item.expectedPpm[nucleus][node])));
      expect(worst, `latency case ${item.latencyCase}`).toBeLessThanOrEqual(tolerance);
    }
  }, 120_000);
});
