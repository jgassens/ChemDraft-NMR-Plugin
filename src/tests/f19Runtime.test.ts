// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { GnnMoleculeFeatures } from "../providers/gnn/featurize";
import {
  GNN_ALLOWED_ISOTOPES,
  GNN_CHARGE_STATE_MIN,
  GNN_DOMAIN_MARGIN,
  GNN_ELEMENT_MIN
} from "../providers/gnn/domainRules";
import { F19_ASSETS } from "../providers/gnn/f19/assets";
import {
  F19_HOSE_TABLE,
  F19_MODEL_RELEASE,
  F19_TRAINING_DOMAIN_SHA256,
  GNN_MODEL_FILES
} from "../providers/gnn/modelRelease";
import { bundledModelUrl, GnnModelRuntime, type OrtModuleLike } from "../providers/gnn/runtime";
import { packGnnInputs, type GnnInputTensors } from "../providers/gnn/tensors";
import { GNN_TRAINING_DOMAIN } from "../providers/gnn/trainingDomain";
import reference from "./fixtures/gnn-onnx-reference-19F.json" with { type: "json" };

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
  /** The molecule's record number in the experiment's ¹⁹F extraction (validation partition). */
  record: number;
  atoms: { shape: number[]; data: number[] };
  neighbor: { shape: number[]; data: number[] };
  bonds: { shape: number[]; data: number[] };
  mask: { shape: number[]; data: number[] };
  features: Omit<GnnMoleculeFeatures, "schemaVersion">;
  expectedPpm: { "19F": number[] };
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

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

describe("bundled ¹⁹F model files", () => {
  it("match the frozen SHA-256 values and sizes", () => {
    const bytes = readFileSync(bundledModelUrl("19F"));
    expect(bundledModelUrl("19F").pathname.endsWith("/gnn/model-19F/19F.fp16.onnx")).toBe(true);
    expect(bytes.byteLength).toBe(GNN_MODEL_FILES["19F"].bytes);
    expect(sha256(bytes)).toBe(GNN_MODEL_FILES["19F"].sha256);
    expect(GNN_MODEL_FILES["19F"].sha256).toBe("fc2abb4f978b873fc899b8d57834c6df4daa19a1a2b23caf25ff58e388ea31aa");
    // The parity fixture was produced with exactly this model and checkpoint.
    expect(reference.model.sha256).toBe(GNN_MODEL_FILES["19F"].sha256);
    expect(reference.model.checkpointSha256).toBe(F19_MODEL_RELEASE.checkpointSha256);
    expect(sha256(readFileSync(new URL("../providers/gnn/model-19F/domain.json", import.meta.url)))).toBe(F19_TRAINING_DOMAIN_SHA256);
    const table = readFileSync(new URL("../providers/gnn/model-19F/hose-table.json", import.meta.url));
    expect(table.byteLength).toBe(F19_HOSE_TABLE.bytes);
    expect(sha256(table)).toBe(F19_HOSE_TABLE.sha256);
  });

  it("ships the ¹⁹F training domain with the §5 thresholds and the gate table as built", () => {
    const domain = F19_ASSETS.domain;
    expect(domain.schema_version).toBe("1");
    // Same feature schema as the ¹H/¹³C models.
    expect(domain.atom_features_sha256).toBe(GNN_TRAINING_DOMAIN.atom_features_sha256);
    expect(domain.size_limit).toBe(Math.min(domain.heavy_atoms_p999, 500));
    expect(domain.thresholds).toMatchObject({
      element_min: GNN_ELEMENT_MIN,
      charge_state_min: GNN_CHARGE_STATE_MIN,
      domain_margin: GNN_DOMAIN_MARGIN,
      allowed_isotopes: [...GNN_ALLOWED_ISOTOPES],
      size_ui_limit: 500
    });
    const table = F19_ASSETS.table;
    expect(table).toMatchObject({
      kind: "f19-hose-table",
      table: "gate",
      partitions: ["train", "val"],
      nucleus: "19F",
      statistic: "median",
      min_observations: 5,
      spheres: [4, 3, 2, 1],
      protocol_commit: F19_MODEL_RELEASE.protocolCommit
    });
    expect(table.input.sha256).toBe(F19_HOSE_TABLE.inputSha256);
    for (const environments of Object.values(table.environments)) {
      for (const entry of Object.values(environments)) expect(entry.n).toBeGreaterThanOrEqual(5);
    }
  });
});

describe("GnnModelRuntime and the ¹⁹F model", () => {
  it("loads the ¹⁹F model only when ¹⁹F is requested", async () => {
    const fetchAsset = vi.fn(readAsset);
    const loadOrt = vi.fn(async () => (await import("onnxruntime-web/wasm")) as unknown as OrtModuleLike);
    const runtime = new GnnModelRuntime({ fetchAsset, loadOrt });
    expect(runtime.requested).toEqual([]);
    const state = await runtime.load("19F");
    expect(state.status).toBe("ready");
    expect(fetchAsset).toHaveBeenCalledTimes(1);
    expect(fetchAsset.mock.calls[0][0].pathname.endsWith("/model-19F/19F.fp16.onnx")).toBe(true);
    expect(runtime.requested).toEqual(["19F"]);
  }, 60_000);

  it("treats a ¹⁹F checksum mismatch as unavailable and never imports the runtime", async () => {
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
    expect(await tampered.load("19F")).toMatchObject({ status: "unavailable", nucleus: "19F", reason: "checksum-mismatch" });
    // The ¹³C model is a different file with a different pin: the ¹⁹F pin never accepts it.
    const swapped = new GnnModelRuntime({ fetchAsset: async () => readAsset(bundledModelUrl("13C")), loadOrt });
    expect(await swapped.load("19F")).toMatchObject({ status: "unavailable", reason: "checksum-mismatch" });
    expect(loadOrt).not.toHaveBeenCalled();
  });
});

describe("¹⁹F GNN tensors match the training packing", () => {
  it.each(cases.map((item) => [item.record, item] as const))(
    "record %i: packGnnInputs reproduces the tensors py/featurize.py packed",
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

describe("¹⁹F GNN ONNX outputs", () => {
  // The expectations are 19F.fp16.onnx's outputs under onnxruntime 1.19.2 on the CPU (float32), on
  // validation-partition tensors of the ¹⁹F feature cache. ONNX Runtime Web (WASM, one thread) must
  // reproduce every node's ppm within the fixture's tolerance.
  it("has seven validation records and a 0.05 ppm tolerance", () => {
    expect(cases).toHaveLength(7);
    expect(reference.tolerancePpm["19F"]).toBe(0.05);
  });

  it.each(cases.map((item) => [item.record, item] as const))(
    "record %i: ONNX Runtime Web matches expectedPpm",
    async (record, item) => {
      const runtime = new GnnModelRuntime({ fetchAsset: readAsset });
      const state = await runtime.load("19F");
      if (state.status !== "ready") throw new Error(`model unavailable: ${state.message}`);
      const ppm = await state.model.run({ features: { schemaVersion: "1", ...item.features }, tensors: tensorsOf(item) });
      expect(ppm).toHaveLength(item.atoms.shape[1]);
      expect(item.expectedPpm["19F"]).toHaveLength(item.atoms.shape[1]);
      const worst = Math.max(...Array.from(ppm, (value, node) => Math.abs(value - item.expectedPpm["19F"][node])));
      expect(worst, `record ${record}`).toBeLessThanOrEqual(reference.tolerancePpm["19F"]);
    },
    60_000
  );
});
