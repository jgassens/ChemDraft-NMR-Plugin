// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { NmrPredictionRequest } from "../domain/contracts";
import {
  canonicalErrorLine,
  canonicalFeatureLine,
  featurizationErrorCode,
  molfileStructureInput,
  sha256Hex
} from "../providers/gnn/canonicalDump";
import { featurizeMolecule, featurizeStructure, type GnnMoleculeFeatures } from "../providers/gnn/featurize";
import { GnnShiftPredictor } from "../providers/gnn/GnnShiftPredictor";
import type { GnnModelInput, GnnModelProvider } from "../providers/gnn/runtime";
import { packGnnInputs } from "../providers/gnn/tensors";
import { parseNmredataMolecule } from "../providers/ocl/nmredataMolecule";
import { createNmrWorkerHandler } from "../worker/nmrWorkerCore";
import type { NmrWorkerResponse } from "../worker/protocol";
import fixture from "./fixtures/gnn-worker-parity.json" with { type: "json" };

/**
 * Worker-path parity: the features the plugin's worker computes while predicting equal the features
 * the GNN was trained on. The training extract computed them with `featurizeStructure` on each
 * corpus molfile (and checked them against `featurizeMolecule(parseNmredataMolecule(...).molecule)`);
 * the worker computes them inside `GnnShiftPredictor.predict`, reached through the worker message
 * handler with structured cloning. These hand-authored hard cases pin the training-path line hashes;
 * the validation partition itself was checked with `scripts/gnn-worker-parity.ts`, whose result
 * hashes are recorded in the same fixture.
 */

interface SyntheticCase {
  name: string;
  category: string;
  molfile: string;
  lineSha256: string;
  featurized: boolean;
  error?: string;
}
const cases = fixture.synthetic as SyntheticCase[];

function workerPath() {
  let observed: { features: GnnMoleculeFeatures } | { error: string } | undefined;
  const modelInputs: GnnModelInput[] = [];
  const models: GnnModelProvider = {
    load: async (nucleus) => ({
      status: "ready",
      model: {
        nucleus,
        sha256: "parity-probe",
        run: async (input) => {
          modelInputs.push(structuredClone(input));
          return new Float32Array(input.tensors.atomCount);
        }
      }
    })
  };
  const responses: NmrWorkerResponse[] = [];
  // Responses are structured clones, as postMessage delivers them.
  const handle = createNmrWorkerHandler((response) => responses.push(structuredClone(response)), {
    createPredictor: () => new GnnShiftPredictor({ models, onFeatures: (outcome) => (observed = outcome) })
  });
  let next = 0;
  return async (molfile: string, nuclei: NmrPredictionRequest["nuclei"]) => {
    observed = undefined;
    modelInputs.length = 0;
    const requestId = `p${next++}`;
    handle({
      type: "predict",
      requestId,
      sourceFingerprint: requestId,
      request: {
        structure: molfileStructureInput(molfile),
        nuclei,
        options: { statistic: "median", hoseLevels: [4, 3, 2, 1], ignoreLabileHydrogens: true }
      }
    });
    for (let i = 0; i < 2000 && !responses.some((response) => response.requestId === requestId); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const response = responses.find((candidate) => candidate.requestId === requestId);
    if (!response) throw new Error(`no worker response for ${requestId}`);
    return { response, observed, modelInputs: [...modelInputs] };
  };
}

describe("GNN worker-path feature parity (hand-authored hard cases)", () => {
  it("covers the required hard-case categories", () => {
    const categories = new Set(cases.map((item) => item.category));
    for (const category of ["charged", "aromatic-heterocycle", "stereo", "isotope", "radical", "declined-element", "declined-size", "graph"]) {
      expect(categories, category).toContain(category);
    }
    expect(cases.length).toBeGreaterThanOrEqual(30);
  });

  const run = workerPath();
  it.each(cases.map((item, index) => [item.name, item, index] as const))("%s", async (_, item, index) => {
    const molfileSha256 = await sha256Hex(item.molfile);
    const identity = { index, molfileSha256 };

    // Training path, as the experiment's extract computed it.
    let training: string;
    let trainingFeatures: GnnMoleculeFeatures | undefined;
    try {
      trainingFeatures = featurizeStructure(molfileStructureInput(item.molfile));
      training = canonicalFeatureLine(identity, trainingFeatures);
    } catch (error) {
      training = canonicalErrorLine(identity, featurizationErrorCode(error));
    }
    expect(await sha256Hex(training)).toBe(item.lineSha256);

    // The extract's cross-check: the NMReDATA parse gives the same features.
    const parsed = parseNmredataMolecule(item.molfile);
    if (trainingFeatures && parsed) {
      expect(canonicalFeatureLine(identity, featurizeMolecule(parsed.molecule))).toBe(training);
    }

    for (const nuclei of [["13C"], ["1H"]] as const) {
      const { response, observed, modelInputs } = await run(item.molfile, nuclei);
      if (!item.featurized) {
        // The structure is rejected before any features exist; the worker reports the dump's code.
        expect(response).toMatchObject({ type: "error", error: { code: item.error } });
        continue;
      }
      expect(response.type).toBe("result");
      expect(observed && "features" in observed).toBe(true);
      const worker = canonicalFeatureLine(identity, (observed as { features: GnnMoleculeFeatures }).features);
      expect(worker).toBe(training);
      // What the model receives is exactly the training packing of those features.
      const expected = packGnnInputs(trainingFeatures!);
      for (const input of modelInputs) {
        expect(canonicalFeatureLine(identity, input.features)).toBe(training);
        expect(Array.from(input.tensors.atoms)).toEqual(Array.from(expected.atoms));
        expect(Array.from(input.tensors.neighbor)).toEqual(Array.from(expected.neighbor));
        expect(Array.from(input.tensors.bonds)).toEqual(Array.from(expected.bonds));
        expect(Array.from(input.tensors.mask)).toEqual(Array.from(expected.mask));
      }
    }
  }, 30_000);
});

describe("GNN worker-path feature parity (validation partition record)", () => {
  it("records a passing full-partition run against the frozen experiment inputs", () => {
    expect(fixture.sources).toEqual({
      records_sha256: "f0dff542cc163dcc3301c7b68c9b400f47f6f58a8a922da962099b47d881f944",
      split_sha256: "ba1f201350988b20b82a282ae175be151ee23f522f424d84915f185b0d1ff047",
      features_dump_sha256: "bd3a7a34e022dc888d81052b87032a363f6457b7de479e0d6c0e4533b287b0c1"
    });
    expect(fixture.validation.partition).toBe("val");
    expect(fixture.validation.records).toBe(4667);
    expect(fixture.validation.passed).toBe(true);
    expect(fixture.validation.workerPathSha256).toBe(fixture.validation.dumpSha256);
    // Identifiers and hashes only: no corpus record or feature row is committed.
    for (const item of fixture.validationHardCases) {
      expect(Object.keys(item).sort()).toEqual(["category", "lineSha256", "molfileSha256", "record"]);
    }
    expect(fixture.validationHardCases.length).toBeGreaterThanOrEqual(20);
  });
});
