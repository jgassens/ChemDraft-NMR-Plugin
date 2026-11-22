// @vitest-environment node
import { readFile } from "node:fs/promises";
import { afterAll, describe, expect, it, vi } from "vitest";
import { PluginPanelReportSchema, type PluginCommandContext, type PluginPanelReport, type PluginSelectedMolecule } from "@chemdraft/plugin-api";

import { normalizeStructure } from "../application/normalizeStructure";
import type { NmrNucleus, NmrPredictionRequest, NmrPredictionResult, NmrPredictor, NmrResonance } from "../domain/contracts";
import { NmrPredictionResultSchema } from "../domain/schemas";
import { NmrWarningCodes } from "../domain/warnings";
import { F19_ASSETS, type F19Assets } from "../providers/gnn/f19/assets";
import { fluorineFragment, fluorineScope } from "../providers/gnn/f19/fluorineScope";
import { f19HoseTier, lookupF19Hose, type F19HoseTable } from "../providers/gnn/f19/hoseTable";
import { F19_MULTIPLE_ENVIRONMENTS_MESSAGE, f19TypeNotPredictedMessage } from "../providers/gnn/f19/predictFluorine";
import { GnnShiftPredictor } from "../providers/gnn/GnnShiftPredictor";
import {
  F19_AGREEMENT_BAND_PPM,
  F19_HOSE_TABLE,
  F19_MEASURED_ACCURACY,
  F19_MODEL_RELEASE,
  type GnnModelKey
} from "../providers/gnn/modelRelease";
import { GnnModelRuntime, type GnnModelProvider, type OrtModuleLike } from "../providers/gnn/runtime";
import { benchmarkTier } from "../providers/ocl/benchmark";
import { cleanRow } from "../providers/ocl/f19/clean";
import { prepareProductionLookup } from "../providers/ocl/productionLookup";
import { nmrPredictFluorineCommandId, nmrPredictorPanelId } from "../manifest";
import { createNmrRegistration } from "../register";
import { composePredictionReport } from "../report/composePredictionReport";
import { renderStickSpectrumSvg } from "../report/stickSpectrumSvg";

// In Node, ONNX Runtime Web's Emscripten loader sets `global.Worker` (worker_threads). Undo it so
// later test files that check for a missing Worker are unaffected.
const hadWorker = "Worker" in globalThis;
const previousWorker = (globalThis as { Worker?: unknown }).Worker;
afterAll(() => {
  if (hadWorker) (globalThis as { Worker?: unknown }).Worker = previousWorker;
  else delete (globalThis as { Worker?: unknown }).Worker;
});

const OPTIONS = { statistic: "median" as const, hoseLevels: [4, 3, 2, 1], ignoreLabileHydrogens: true };
const readAsset = async (url: URL): Promise<Uint8Array> => new Uint8Array(await readFile(url));

function smiles(value: string, nuclei: NmrNucleus[] = ["19F"]): NmrPredictionRequest {
  return { structure: { format: "smiles", value }, nuclei, options: OPTIONS };
}

/** A ¹⁹F model stand-in returning `value` at every node; records which models were requested. */
function fakeModels(value: number | (() => never) = -62) {
  const loads: GnnModelKey[] = [];
  const provider: GnnModelProvider = {
    load: async (nucleus) => {
      loads.push(nucleus);
      return {
        status: "ready",
        model: {
          nucleus,
          sha256: "test",
          run: async (input) =>
            typeof value === "number" ? Float32Array.from(input.features.heavyAtomIndexMap, () => value) : value()
        }
      };
    }
  };
  return { provider, loads };
}

function counted(assets: F19Assets = F19_ASSETS) {
  const calls = { count: 0 };
  return { calls, load: async () => { calls.count += 1; return assets; } };
}

function predictor(models: GnnModelProvider, assets = counted()) {
  return new GnnShiftPredictor({ models, fluorineAssets: assets.load, now: () => "t" });
}

const fluorineOnly = (result: NmrPredictionResult): NmrResonance[] => result.resonances.filter((r) => r.nucleus === "19F");
const f19Warnings = (result: NmrPredictionResult) => result.warnings.filter((warning) => warning.details?.nucleus === "19F");

describe("¹⁹F scope: CF3 only, one fluorine environment", () => {
  it("predicts a single-environment CF3 group with the GNN, its tier and the HOSE reference", async () => {
    const { provider, loads } = fakeModels(-62);
    const assets = counted();
    const result = await predictor(provider, assets).predict(smiles("FC(F)(F)c1ccccc1"));
    expect(result.resonances).toHaveLength(1);
    const [cf3] = result.resonances;
    expect(cf3).toMatchObject({
      id: "f-0",
      nucleus: "19F",
      source: "model",
      method: "GNN prediction",
      tier: "high",
      deltaPpm: -62,
      equivalentNuclei: 3,
      reference: { method: "HOSE lookup", deltaPpm: -62.59, matchedSphere: 4, sampleCount: 8855 },
      evidence: { method: "gnn" }
    });
    expect(cf3.atomRefs.map((ref) => [ref.sourceAtomIndex, ref.element])).toEqual([[0, "F"], [2, "F"], [3, "F"]]);
    expect(loads).toEqual(["19F"]);
    expect(assets.calls.count).toBe(1);
    expect(result.backend).toMatchObject({
      id: "chemdraft.gnn-hose",
      method: "gnn",
      dataVersion: F19_HOSE_TABLE.name,
      version: F19_HOSE_TABLE.version,
      license: "CC BY 4.0 (NMRexp)",
      dataChecksum: F19_HOSE_TABLE.inputSha256,
      model: { id: F19_MODEL_RELEASE.id, version: F19_MODEL_RELEASE.version, nuclei: ["19F"], dataLicense: "CC BY 4.0 (NMRexp)" }
    });
    expect(result.backend.attribution).toContain("10.5281/zenodo.17296666");
    expect(f19Warnings(result)).toEqual([]);
    expect(result.depiction?.atoms.length).toBeGreaterThan(0);
    const parsed = NmrPredictionResultSchema.parse(result);
    expect(parsed.backend.model?.id).toBe(F19_MODEL_RELEASE.id);
    expect(parsed.resonances[0].nucleus).toBe("19F");
  });

  it.each([
    ["CF2", "CC(F)(F)C", "CF2"],
    ["aryl-F", "Fc1ccccc1", "aryl-F"],
    ["hetero-F", "FS(=O)(=O)c1ccccc1", "hetero-F"],
    ["acyl-F", "CC(=O)F", "acyl-F"],
    ["vinyl-F", "C=CF", "vinyl-F"],
    ["alkyl-F", "CCF", "alkyl-F"]
  ])("declines %s with the exact warning and no shift, consulting neither model nor table", async (_, value, type) => {
    const { provider, loads } = fakeModels();
    const assets = counted();
    const result = await predictor(provider, assets).predict(smiles(value));
    expect(result.resonances).toEqual([]);
    const warnings = f19Warnings(result);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      code: NmrWarningCodes.FluorineTypeNotPredicted,
      message: `¹⁹F prediction covers CF3 groups only in this version; ${type} is not predicted.`,
      details: { nucleus: "19F", fluorineType: type }
    });
    expect(warnings[0].message).toBe(f19TypeNotPredictedMessage(type));
    expect(loads).toEqual([]);
    expect(assets.calls.count).toBe(0);
    expect(result.backend.model).toBeUndefined();
  });

  it("declines a molecule with two fluorine environments with the exact warning and no shift", async () => {
    const { provider, loads } = fakeModels();
    const assets = counted();
    const result = await predictor(provider, assets).predict(smiles("FC(F)(F)c1ccc(F)cc1"));
    expect(result.resonances).toEqual([]);
    const warnings = f19Warnings(result);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      code: NmrWarningCodes.FluorineMultipleEnvironments,
      message: "¹⁹F prediction is limited to molecules with one fluorine environment in this version.",
      atomIndices: [0, 2, 3, 8]
    });
    expect(warnings[0].message).toBe(F19_MULTIPLE_ENVIRONMENTS_MESSAGE);
    expect(loads).toEqual([]);
    expect(assets.calls.count).toBe(0);
  });

  it("declines two CF3 groups in different environments, even though each is CF3", async () => {
    const result = await predictor(fakeModels().provider).predict(smiles("FC(F)(F)c1ccccc1CC(F)(F)F"));
    expect(result.resonances).toEqual([]);
    expect(f19Warnings(result).map((warning) => warning.message)).toEqual([F19_MULTIPLE_ENVIRONMENTS_MESSAGE]);
  });

  it("predicts symmetry-equivalent CF3 groups as one environment", async () => {
    const result = await predictor(fakeModels(-63).provider).predict(smiles("FC(F)(F)c1cccc(C(F)(F)F)c1"));
    expect(result.resonances).toHaveLength(1);
    expect(result.resonances[0]).toMatchObject({ method: "GNN prediction", equivalentNuclei: 6 });
  });

  it("declines fluorine spread over separate fragments with a specific message", async () => {
    const { provider, loads } = fakeModels();
    const result = await predictor(provider).predict(smiles("FC(F)(F)C(=O)[O-].FC(F)(F)C(=O)[O-].[Mg+2]"));
    expect(result.resonances).toEqual([]);
    const [warning] = f19Warnings(result);
    expect(warning.code).toBe(NmrWarningCodes.FluorineMultipleEnvironments);
    expect(warning.message.startsWith("¹⁹F prediction is limited to molecules with one fluorine environment in this version;")).toBe(true);
    expect(warning.message).toContain("2 separate fragments");
    expect(loads).toEqual([]);
  });

  it("predicts the fluorine-bearing fragment of a salt and reports input atom indices", async () => {
    const runs: number[] = [];
    const provider: GnnModelProvider = {
      load: async (nucleus) => ({
        status: "ready",
        model: {
          nucleus,
          sha256: "test",
          run: async (input) => {
            runs.push(input.features.atoms.length);
            return Float32Array.from(input.features.heavyAtomIndexMap, () => -76);
          }
        }
      })
    };
    const result = await predictor(provider).predict(smiles("[Na+].[O-]C(=O)C(F)(F)F"));
    expect(result.resonances).toHaveLength(1);
    expect(result.resonances[0].atomRefs.map((ref) => ref.sourceAtomIndex)).toEqual([5, 6, 7]);
    // The model saw the trifluoroacetate fragment only (7 heavy atoms), not the sodium ion.
    expect(runs).toEqual([7]);
    // Trifluoroacetate matches the gate table at sphere 2: agreement gives medium.
    expect(result.resonances[0]).toMatchObject({ method: "GNN prediction", tier: "medium", reference: { matchedSphere: 2 } });
  });

  it("gives nothing and says nothing for a molecule without fluorine", async () => {
    const { provider, loads } = fakeModels();
    const assets = counted();
    const result = await predictor(provider, assets).predict(smiles("c1ccccc1"));
    expect(result.resonances).toEqual([]);
    expect(f19Warnings(result)).toEqual([]);
    expect(result.warnings.filter((warning) => warning.code.startsWith("NMR_F19"))).toEqual([]);
    expect(loads).toEqual([]);
    expect(assets.calls.count).toBe(0);
  });

  it("classifies molecules exactly as the reviewed cleaning code does", () => {
    for (const value of [
      "FC(F)(F)c1ccccc1", "CC(F)(F)C", "Fc1ccccc1", "FS(=O)(=O)c1ccccc1", "FC(F)(F)c1ccc(F)cc1",
      "FC(F)(F)c1cccc(C(F)(F)F)c1", "[Na+].[O-]C(=O)C(F)(F)F", "FC(F)(F)C(=O)[O-].FC(F)(F)C(=O)[O-].[Mg+2]",
      "FC(F)(F)F", "FC(F)F", "OC(C(F)(F)F)C(F)(F)F", "FC(F)(F)C=C", "N#CC(F)(F)F", "FC(F)(F)S(=O)(=O)O"
    ]) {
      const { molecule } = normalizeStructure({ format: "smiles", value });
      const scope = fluorineScope(molecule, prepareProductionLookup(molecule));
      const cleaned = cleanRow({ row: 0, filename: "x", smiles: value, solvent: null, peaks: ["-63"] });
      if ("drop" in cleaned) {
        expect(["multiple-environments", "multiple-fragments"], value).toContain(scope.kind);
        expect(["multiple-fluorine-environments", "fluorine-in-multiple-fragments"], value).toContain(cleaned.drop);
      } else if (cleaned.fluorineType === "CF3") {
        expect(scope.kind, value).toBe("cf3");
      } else {
        expect(scope, value).toMatchObject({ kind: "type-not-predicted", type: cleaned.fluorineType });
      }
    }
  });

  it("cuts the fluorine-bearing fragment with an exact atom mapping", () => {
    const { molecule } = normalizeStructure({ format: "smiles", value: "CCN.FC(F)(F)c1ccccc1.Cl" });
    const fragment = fluorineFragment(molecule, [3, 5, 6]);
    expect(fragment.molecule.getAllAtoms()).toBe(10);
    expect(fragment.toInput).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect([0, 1, 2, 13].map((atom) => fragment.fromInput[atom])).toEqual([-1, -1, -1, -1]);
  });
});

describe("¹⁹F tiers and the 5.5 ppm agreement band", () => {
  it("freezes the band at 5.5 ppm", () => {
    expect(F19_AGREEMENT_BAND_PPM).toBe(5.5);
  });

  it("reports a disagreement beyond the band with tier low, both values and the warning", async () => {
    const result = await predictor(fakeModels(-75).provider).predict(smiles("FC(F)(F)c1ccccc1"));
    expect(result.resonances[0]).toMatchObject({
      method: "GNN prediction",
      tier: "low",
      deltaPpm: -75,
      disagreesWithReference: true,
      reference: { deltaPpm: -62.59 }
    });
    const [warning] = result.warnings.filter((entry) => entry.code === NmrWarningCodes.ModelLookupDisagreement);
    expect(warning.message).toContain("model and reference lookup disagree");
    expect(warning.message).toContain("-75.00");
    expect(warning.message).toContain("-62.59");
    expect(warning.details).toMatchObject({ nucleus: "19F", bandPpm: 5.5 });
  });

  it("keeps a value exactly on the band edge in agreement", async () => {
    const result = await predictor(fakeModels(-62.59 - 5.5).provider).predict(smiles("FC(F)(F)c1ccccc1"));
    expect(result.resonances[0].disagreesWithReference).toBeUndefined();
    expect(result.resonances[0].tier).toBe("high");
  });

  it("uses the training-domain margin when the table has no match", async () => {
    const empty: F19HoseTable = { ...F19_ASSETS.table, environments: { "1": {}, "2": {}, "3": {}, "4": {} } };
    const result = await predictor(fakeModels(-63).provider, counted({ ...F19_ASSETS, table: empty })).predict(smiles("FC(F)(F)c1ccccc1"));
    expect(result.resonances[0]).toMatchObject({ method: "GNN prediction", tier: "medium" });
    expect(result.resonances[0].reference).toBeUndefined();
  });

  it("gives the HOSE fallback the production benchmark tier", () => {
    for (const sphere of [1, 2, 3, 4]) {
      for (const n of [1, 2, 3, 5, 7, 8, 9, 100]) expect(f19HoseTier(sphere, n)).toBe(benchmarkTier(sphere, n));
    }
  });

  it("looks up the deepest sphere of the gate table, by the production environment codes", () => {
    const { molecule } = normalizeStructure({ format: "smiles", value: "FC(F)(F)c1ccccc1" });
    expect(lookupF19Hose(F19_ASSETS.table, prepareProductionLookup(molecule), 0)).toEqual({
      deltaPpm: -62.59,
      sphere: 4,
      sampleCount: 8855,
      environmentCode: expect.stringMatching(/^Fq0h0\(1Ch0\)/),
      tier: "high"
    });
    const shallow = normalizeStructure({ format: "smiles", value: "FC(F)(F)C(=O)O" }).molecule;
    expect(lookupF19Hose(F19_ASSETS.table, prepareProductionLookup(shallow), 0)).toMatchObject({ sphere: 2, deltaPpm: -71.67, tier: "medium" });
  });
});

describe("¹⁹F fallback (§5): HOSE lookup, else no shift", () => {
  it("falls back to the HOSE lookup when the model fails its checksum, without importing the runtime", async () => {
    const loadOrt = vi.fn(async (): Promise<OrtModuleLike> => {
      throw new Error("must not be called");
    });
    const runtime = new GnnModelRuntime({
      fetchAsset: async (url) => {
        const bytes = await readAsset(url);
        bytes[0] ^= 0xff;
        return bytes;
      },
      loadOrt
    });
    const result = await predictor(runtime).predict(smiles("FC(F)(F)c1ccccc1"));
    expect(result.resonances).toHaveLength(1);
    expect(result.resonances[0]).toMatchObject({
      nucleus: "19F",
      source: "lookup",
      method: "HOSE lookup",
      tier: "high",
      deltaPpm: -62.59,
      equivalentNuclei: 3,
      evidence: { method: "hose-fragment", matchedSphere: 4, sampleCount: 8855 }
    });
    const [warning] = result.warnings.filter((entry) => entry.code === NmrWarningCodes.GnnModelUnavailable);
    expect(warning.details).toMatchObject({ nucleus: "19F", reason: "checksum-mismatch" });
    expect(warning.message).toContain("¹⁹F shifts are HOSE lookup values");
    expect(result.backend.method).toBe("hose-fragment");
    expect(result.backend.model).toBeUndefined();
    expect(loadOrt).not.toHaveBeenCalled();
    expect(NmrPredictionResultSchema.safeParse(result).success).toBe(true);
  });

  it("falls back when the model file is missing or inference fails", async () => {
    const missing = new GnnModelRuntime({ fetchAsset: async () => { throw new Error("HTTP 404"); } });
    const fromMissing = await predictor(missing).predict(smiles("FC(F)(F)c1ccccc1"));
    expect(fromMissing.resonances[0]).toMatchObject({ method: "HOSE lookup", deltaPpm: -62.59 });
    expect(fromMissing.warnings.some((entry) => entry.code === NmrWarningCodes.GnnModelUnavailable && entry.details?.reason === "missing")).toBe(true);

    const failing = fakeModels(() => { throw new Error("boom"); });
    const fromFailure = await predictor(failing.provider).predict(smiles("FC(F)(F)c1ccccc1"));
    expect(fromFailure.resonances[0]).toMatchObject({ method: "HOSE lookup", deltaPpm: -62.59 });
    expect(fromFailure.warnings.some((entry) => entry.code === NmrWarningCodes.GnnInferenceFailed)).toBe(true);
  });

  it("shows the HOSE value, with the decline rules, where the GNN declines", async () => {
    // 70 carbons: above the ¹⁹F model's 64-heavy-atom size limit (rule 5).
    const result = await predictor(fakeModels(-1).provider).predict(smiles(`FC(F)(F)${"C".repeat(70)}`));
    expect(result.resonances).toHaveLength(1);
    expect(result.resonances[0]).toMatchObject({ method: "HOSE lookup", modelDeclines: ["size"] });
    expect(result.resonances[0].tier).toBeDefined();
    const [declined] = result.warnings.filter((entry) => entry.code === NmrWarningCodes.GnnDeclined);
    expect(declined.details).toMatchObject({ nucleus: "19F", rules: ["size"] });
  });

  it("gives no shift when neither the model nor the table has a value", async () => {
    const empty: F19HoseTable = { ...F19_ASSETS.table, environments: {} };
    const missing = new GnnModelRuntime({ fetchAsset: async () => { throw new Error("HTTP 404"); } });
    const result = await predictor(missing, counted({ ...F19_ASSETS, table: empty })).predict(smiles("FC(F)(F)c1ccccc1"));
    expect(result.resonances).toEqual([]);
    expect(result.warnings.some((entry) => entry.code === NmrWarningCodes.NoFragmentMatch && entry.details?.nucleus === "19F")).toBe(true);
  });
});

describe("¹⁹F lazy loading", () => {
  it("never loads the ¹⁹F model or table for ¹H, ¹³C or ³¹P, even on a CF3 molecule", async () => {
    const { provider, loads } = fakeModels();
    const assets = counted();
    const gnn = predictor(provider, assets);
    await gnn.getCapabilities();
    await gnn.predict(smiles("FC(F)(F)c1ccccc1", ["13C"]));
    await gnn.predict(smiles("FC(F)(F)c1ccccc1", ["1H"]));
    await gnn.predict(smiles("FC(F)(F)c1ccc(P(C)C)cc1", ["31P"]));
    expect(loads).toEqual(["13C", "1H"]);
    expect(assets.calls.count).toBe(0);
    await gnn.predict(smiles("FC(F)(F)c1ccccc1"));
    expect(loads).toEqual(["13C", "1H", "19F"]);
    expect(assets.calls.count).toBe(1);
  });

  it("leaves ¹³C results unchanged when ¹⁹F is requested beside them", async () => {
    const gnn = predictor(fakeModels(-62).provider);
    const carbonOnly = await gnn.predict(smiles("FC(F)(F)c1ccccc1", ["13C"]));
    const both = await gnn.predict(smiles("FC(F)(F)c1ccccc1", ["13C", "19F"]));
    expect(both.resonances.filter((resonance) => resonance.nucleus === "13C")).toEqual(carbonOnly.resonances);
    expect(fluorineOnly(both)).toHaveLength(1);
    expect(both.backend).toMatchObject({
      dataVersion: carbonOnly.backend.dataVersion,
      model: carbonOnly.backend.model,
      fluorineDatabase: { dataVersion: F19_HOSE_TABLE.name, dataChecksum: F19_HOSE_TABLE.inputSha256 },
      fluorineModel: { id: F19_MODEL_RELEASE.id }
    });
    expect(NmrPredictionResultSchema.parse(both).backend.fluorineModel?.id).toBe(F19_MODEL_RELEASE.id);
  });

  it("advertises ¹⁹F in the capabilities without loading anything", async () => {
    const { provider, loads } = fakeModels();
    const capabilities = await predictor(provider).getCapabilities();
    expect(capabilities.nuclei).toContain("19F");
    expect(loads).toEqual([]);
  });
});

describe("¹⁹F with the bundled model", () => {
  it("predicts benzotrifluoride through ONNX Runtime Web", async () => {
    const result = await predictor(new GnnModelRuntime({ fetchAsset: readAsset })).predict(smiles("FC(F)(F)c1ccccc1"));
    expect(result.resonances).toHaveLength(1);
    const [cf3] = result.resonances;
    expect(cf3.method).toBe("GNN prediction");
    expect(cf3.tier).toBeDefined();
    // Aryl-CF3 is near −63 ppm.
    expect(cf3.deltaPpm).toBeGreaterThan(-70);
    expect(cf3.deltaPpm).toBeLessThan(-55);
  }, 60_000);
});

describe("¹⁹F in the panel", () => {
  const source: PluginSelectedMolecule = {
    objectId: "m1",
    documentId: "doc1",
    pageId: "p1",
    structureFormat: "smiles",
    structure: "FC(F)(F)c1ccccc1",
    sourceFingerprint: "fp1"
  };
  const json = (report: { sections: unknown[] }) => JSON.stringify(report.sections);

  it("labels CF3 only and shows the partition-named figures for this exact release", async () => {
    const result = await predictor(fakeModels(-62).provider).predict(smiles("FC(F)(F)c1ccccc1"));
    const report = composePredictionReport(source, result);
    expect(PluginPanelReportSchema.safeParse(report).success).toBe(true);
    const text = json(report);
    expect(text).toContain("CF3 only");
    expect(text).toContain("Predicted ¹⁹F NMR (CF3 only)");
    expect(text).toContain(
      "NMRShiftDB2 single-environment CF3 molecules (independent gate, first opening): MAE 3.47 ppm [95% interval 2.25, 5.02], 157 molecules"
    );
    expect(text).toContain("held-out NMRexp source files (10%, molecule-deduplicated), CF3: MAE 3.53 ppm [2.10, 5.23], 6,903 molecules");
    expect(text).toContain("GNN prediction");
    expect(text).toContain("high · HOSE -62.59 (s4, n=8855)");
    // NMRexp credit in the reference database section; NMRShiftDB2 only as the gate.
    expect(text).toContain("Wang, Jun-Jie and Zhu, Rong, NMRexp");
    expect(text).toContain("https://creativecommons.org/licenses/by/4.0/");
    expect(text).toContain("NMRShiftDB2 was used only as the independent test gate");
    // No solvent claim and no ¹H couplings text for ¹⁹F.
    expect(text).not.toContain("CDCl₃");
    expect(text).not.toContain("¹H–¹H couplings");
    // No percentages beyond the interval's name and the partition's size.
    const percentages = text.match(/\d+(?:\.\d+)?\s*%/g) ?? [];
    expect(percentages.every((match) => match === "95%" || match === "10%")).toBe(true);
    expect(renderStickSpectrumSvg(result)).toContain("¹⁹F δ (ppm)");
  });

  it("hides the figures for another model version or another table", async () => {
    const result = await predictor(fakeModels(-62).provider).predict(smiles("FC(F)(F)c1ccccc1"));
    const otherModel = { ...result, backend: { ...result.backend, model: { ...result.backend.model!, version: "other" } } };
    const otherTable = { ...result, backend: { ...result.backend, dataChecksum: "0".repeat(64) } };
    for (const variant of [otherModel, otherTable]) {
      const text = json(composePredictionReport(source, variant));
      expect(text).toContain("CF3 only");
      expect(text).not.toContain(F19_MEASURED_ACCURACY.gate);
      expect(text).not.toContain(F19_MEASURED_ACCURACY.inSourceTest);
    }
  });

  it("shows the HOSE fallback with its method, tier and no figures", async () => {
    const missing = new GnnModelRuntime({ fetchAsset: async () => { throw new Error("HTTP 404"); } });
    const result = await predictor(missing).predict(smiles("FC(F)(F)c1ccccc1"));
    const text = json(composePredictionReport(source, result));
    expect(text).toContain("HOSE lookup");
    expect(text).toContain("high · s4, n=8855");
    expect(text).toContain("CF3 only");
    expect(text).not.toContain(F19_MEASURED_ACCURACY.gate);
  });

  it("explains a declined molecule plainly", async () => {
    const result = await predictor(fakeModels().provider).predict(smiles("Fc1ccccc1"));
    const report = composePredictionReport(source, result);
    const text = json(report);
    expect(text).toContain("no applicable prediction");
    expect(text).toContain("No ¹⁹F shift is shown.");
    expect(text).toContain("CF3 only");
    expect(text).toContain("¹⁹F prediction covers CF3 groups only in this version; aryl-F is not predicted.");
    expect(text).not.toContain("neither the configured reference database");
  });

  it("keeps the ¹³C disclaimer and adds the ¹⁹F note in a mixed result", async () => {
    const result = await predictor(fakeModels(-62).provider).predict(smiles("FC(F)(F)c1ccccc1", ["13C", "19F"]));
    const report = composePredictionReport(source, result);
    const text = json(report);
    expect(text).toContain("Predicted ¹³C NMR");
    expect(text).toContain("Predicted ¹⁹F NMR (CF3 only)");
    expect(text).toContain("trained on NMRShiftDB2 assignments");
    expect(text).toContain("trained on NMRexp ¹⁹F data");
    expect(text).toContain(F19_MEASURED_ACCURACY.gate);
  });
});

describe("¹⁹F command", () => {
  it("runs the predictor for ¹⁹F only and reruns the same command", async () => {
    const requests: NmrPredictionRequest[] = [];
    const stub: NmrPredictor = {
      getCapabilities: () => ({
        id: "stub", version: "0", execution: "worker-js", nuclei: ["19F"], supportsAtomAssignments: true,
        supportsUncertainty: false, supportsCouplings: false, supportsSolvent: false, supportsConformers: false,
        supportsStereochemistry: false
      }),
      predict: async (request) => {
        requests.push(request);
        return { schemaVersion: "1", sourceFingerprint: "fp1", backend: { id: "stub", version: "0", method: "gnn" }, resonances: [], warnings: [], generatedAt: "t" };
      }
    };
    const reports: PluginPanelReport[] = [];
    const molecule: PluginSelectedMolecule = { objectId: "m1", documentId: "d", pageId: "p", structureFormat: "smiles", structure: "FC(F)(F)c1ccccc1", sourceFingerprint: "fp1" };
    const context = {
      selection: { getSelection: async () => ({ objectIds: ["m1"], molecules: [molecule] }) },
      analysis: { write: async (input: unknown) => input, list: async () => [], getLatest: async () => undefined },
      panels: { showReport: async (panelId: string, report: PluginPanelReport) => { if (panelId === nmrPredictorPanelId) reports.push(report); } }
    } as unknown as PluginCommandContext;
    const registration = createNmrRegistration({ predictor: stub });
    await registration.commandHandlers[nmrPredictFluorineCommandId](context);
    expect(requests.map((request) => request.nuclei)).toEqual([["19F"]]);
    expect(reports.length).toBeGreaterThan(0);
    expect(reports.every((report) => report.rerunCommandId === nmrPredictFluorineCommandId)).toBe(true);
  });
});
