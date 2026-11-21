// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { NmrWarningCodes } from "../domain/warnings";
import { GnnShiftPredictor } from "../providers/gnn/GnnShiftPredictor";
import type { GnnModelProvider } from "../providers/gnn/runtime";
import { OclHosePredictor } from "../providers/ocl/OclHosePredictor";

// Rule 5 ("the featurizer reports an unsupported feature"): make the featurizer reject the molecule.
vi.mock("../providers/gnn/featurize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providers/gnn/featurize")>();
  return {
    ...actual,
    featurizeMolecule: () => {
      throw new actual.GnnFeaturizationError(actual.GnnFeaturizationErrorCodes.StereoPerceptionFailed, "probe");
    }
  };
});

describe("GnnShiftPredictor rule 5 (graph)", () => {
  it("declines every atom of a molecule the featurizer rejects and shows the HOSE lookup", async () => {
    let runs = 0;
    const models: GnnModelProvider = {
      load: async (nucleus) => ({ status: "ready", model: { nucleus, sha256: "x", run: async () => { runs += 1; return new Float32Array(0); } } })
    };
    const request = {
      structure: { format: "smiles" as const, value: "CC(=O)OCC" },
      nuclei: ["13C" as const],
      options: { statistic: "median" as const, hoseLevels: [4, 3, 2, 1], ignoreLabileHydrogens: true }
    };
    const result = await new GnnShiftPredictor({ models, now: () => "t" }).predict(request);
    const hose = await new OclHosePredictor({ now: () => "t" }).predict(request);
    expect(runs).toBe(0);
    expect(result.resonances).toEqual(hose.resonances.map((resonance) => ({ ...resonance, method: "HOSE lookup", modelDeclines: ["graph"] })));
    const declined = result.warnings.find((warning) => warning.code === NmrWarningCodes.GnnDeclined);
    expect(declined?.message).toContain("rule 5");
    expect(declined?.details).toEqual({ nucleus: "13C", rules: ["graph"], featurizerError: "GNN_STEREO_PERCEPTION_FAILED" });
  });
});
