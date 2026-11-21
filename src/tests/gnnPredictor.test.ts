// @vitest-environment node
import { readFile } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";

import type {
  NmrNucleus,
  NmrPredictionRequest,
  NmrPredictionResult,
  NmrPredictor,
  NmrResonance
} from "../domain/contracts";
import { NmrPredictionResultSchema } from "../domain/schemas";
import { nmrWarning, NmrWarningCodes, type NmrPredictionWarning } from "../domain/warnings";
import type { GnnMoleculeFeatures } from "../providers/gnn/featurize";
import { GnnShiftPredictor, MODEL_LOOKUP_DISAGREEMENT_PHRASE } from "../providers/gnn/GnnShiftPredictor";
import { GNN_AGREEMENT_BANDS, type GnnNucleus } from "../providers/gnn/modelRelease";
import { GnnModelRuntime, type GnnModelInput, type GnnModelProvider } from "../providers/gnn/runtime";
import { GNN_TRAINING_DOMAIN } from "../providers/gnn/trainingDomain";
import type { GnnTrainingDomain } from "../providers/gnn/domainRules";
import { OclHosePredictor } from "../providers/ocl/OclHosePredictor";
import { createNmrWorkerHandler } from "../worker/nmrWorkerCore";
import type { NmrWorkerResponse } from "../worker/protocol";
import parityFixture from "./fixtures/gnn-worker-parity.json" with { type: "json" };

// In Node, ONNX Runtime Web's Emscripten loader sets `global.Worker` (worker_threads). Undo it so
// later test files that check for a missing Worker are unaffected.
const hadWorker = "Worker" in globalThis;
const previousWorker = (globalThis as { Worker?: unknown }).Worker;
afterAll(() => {
  if (hadWorker) (globalThis as { Worker?: unknown }).Worker = previousWorker;
  else delete (globalThis as { Worker?: unknown }).Worker;
});

const OPTIONS = { statistic: "median" as const, hoseLevels: [4, 3, 2, 1], ignoreLabileHydrogens: true };

function smiles(value: string, nuclei: NmrNucleus[] = ["13C"]): NmrPredictionRequest {
  return { structure: { format: "smiles", value }, nuclei, options: OPTIONS };
}

/** Hand-authored molfiles shared with the worker-parity fixture (radicals, isotopes, size). */
function fixtureMolfile(name: string, nuclei: NmrNucleus[] = ["13C"]): NmrPredictionRequest {
  const entry = parityFixture.synthetic.find((item) => item.name === name);
  if (!entry) throw new Error(`no fixture molecule ${name}`);
  return { structure: { format: "molfile-v2000", value: entry.molfile }, nuclei, options: OPTIONS };
}

/** A model whose per-atom output is chosen by the test: `values[atom]` at that atom's node. */
function fakeModels(values: Partial<Record<GnnNucleus, Record<number, number>>> = {}) {
  const loads: GnnNucleus[] = [];
  const runs: { nucleus: GnnNucleus; input: GnnModelInput }[] = [];
  const provider: GnnModelProvider = {
    load: async (nucleus) => {
      loads.push(nucleus);
      return {
        status: "ready",
        model: {
          nucleus,
          sha256: "test",
          run: async (input) => {
            runs.push({ nucleus, input });
            const table = values[nucleus] ?? {};
            return Float32Array.from(input.features.heavyAtomIndexMap, (atom) => table[atom] ?? 0);
          }
        }
      };
    }
  };
  return { provider, loads, runs };
}

function hoseMatch(nucleus: "1H" | "13C", atoms: number[], deltaPpm: number, sphere: number, sampleCount = 20): NmrResonance {
  return {
    id: `${nucleus === "13C" ? "c" : "h"}-${Math.min(...atoms)}`,
    nucleus,
    source: "lookup",
    deltaPpm,
    atomRefs: atoms.map((atom) => ({ sourceAtomIndex: atom, element: nucleus === "13C" ? "C" : "H", equivalentCount: nucleus === "13C" ? 1 : 3 })),
    equivalentNuclei: atoms.length,
    uncertainty: { standardDeviationPpm: 0.5 },
    evidence: { method: "hose-fragment", matchedSphere: sphere, sampleCount, environmentCode: `code-${atoms.join("-")}` },
    flags: []
  };
}

function ruleEstimate(nucleus: "1H" | "13C", atoms: number[], deltaPpm: number): NmrResonance {
  return {
    id: `${nucleus === "13C" ? "c" : "h"}-est-${Math.min(...atoms)}`,
    nucleus,
    source: "rule-estimate",
    deltaPpm,
    atomRefs: atoms.map((atom) => ({ sourceAtomIndex: atom, element: "C", equivalentCount: 1 })),
    equivalentNuclei: atoms.length,
    evidence: { method: "rule-estimated", environmentCode: "rule", estimator: { id: "rule", version: "1", method: "table" } },
    flags: ["rule-estimated"]
  };
}

/** A HOSE engine stand-in that reports exactly the given resonances and warnings. */
function stubHose(resonances: NmrResonance[], warnings: NmrPredictionWarning[] = []): NmrPredictor {
  return {
    getCapabilities: () => ({
      id: "chemdraft.ocl-hose",
      version: "stub",
      execution: "worker-js",
      nuclei: ["1H", "13C"],
      supportsAtomAssignments: true,
      supportsUncertainty: true,
      supportsCouplings: true,
      supportsSolvent: false,
      supportsConformers: false,
      supportsStereochemistry: false
    }),
    predict: async (request): Promise<NmrPredictionResult> => ({
      schemaVersion: "1",
      sourceFingerprint: "fp",
      backend: { id: "chemdraft.ocl-hose", version: "stub", method: "hose-fragment" },
      resonances: resonances.filter((resonance) => request.nuclei.includes(resonance.nucleus)),
      warnings,
      generatedAt: "t"
    })
  };
}

function byAtoms(result: NmrPredictionResult, nucleus: NmrNucleus, atoms: number[]): NmrResonance | undefined {
  const key = [...atoms].sort((a, b) => a - b).join(",");
  return result.resonances.find(
    (resonance) =>
      resonance.nucleus === nucleus &&
      resonance.atomRefs.map((ref) => ref.sourceAtomIndex).sort((a, b) => a - b).join(",") === key
  );
}

function codes(result: NmrPredictionResult): string[] {
  return result.warnings.map((warning) => warning.code);
}

const readAsset = async (url: URL): Promise<Uint8Array> => new Uint8Array(await readFile(url));

describe("GnnShiftPredictor tiers (ABSTENTION.md section 3)", () => {
  // Ethanol: carbon classes [0] (CH3) and [1] (CH2). Every node and neighbor is a neutral C or O,
  // far above the 500-atom margin, so tiers depend only on the HOSE match.
  const band = GNN_AGREEMENT_BANDS["13C"];

  it("high: a HOSE match at sphere >= 3 within the band", async () => {
    const { provider } = fakeModels({ "13C": { 0: 18.5, 1: 58 } });
    const predictor = new GnnShiftPredictor({ models: provider, hose: stubHose([hoseMatch("13C", [0], 18, 3), hoseMatch("13C", [1], 58.2, 4)]) });
    const result = await predictor.predict(smiles("CCO"));
    expect(byAtoms(result, "13C", [0])).toMatchObject({ method: "GNN prediction", tier: "high", deltaPpm: 18.5 });
    expect(byAtoms(result, "13C", [1])).toMatchObject({ method: "GNN prediction", tier: "high", deltaPpm: 58 });
    expect(byAtoms(result, "13C", [0])?.reference).toEqual({
      method: "HOSE lookup", deltaPpm: 18, matchedSphere: 3, sampleCount: 20, environmentCode: "code-0"
    });
  });

  it("high at the band edge: |GNN − lookup| equal to the band still agrees", async () => {
    const { provider } = fakeModels({ "13C": { 0: 18 + band } });
    const predictor = new GnnShiftPredictor({ models: provider, hose: stubHose([hoseMatch("13C", [0], 18, 3)]) });
    const resonance = byAtoms(await predictor.predict(smiles("CCO")), "13C", [0]);
    expect(resonance).toMatchObject({ tier: "high" });
    expect(resonance?.disagreesWithReference).toBeUndefined();
  });

  it("medium: a sphere 1–2 HOSE match within the band", async () => {
    const { provider } = fakeModels({ "13C": { 0: 18.5, 1: 60 } });
    const predictor = new GnnShiftPredictor({ models: provider, hose: stubHose([hoseMatch("13C", [0], 18, 1), hoseMatch("13C", [1], 58, 2)]) });
    const result = await predictor.predict(smiles("CCO"));
    expect(byAtoms(result, "13C", [0])?.tier).toBe("medium");
    expect(byAtoms(result, "13C", [1])?.tier).toBe("medium");
  });

  it("medium: no HOSE match and the atom and its neighbors clear the 500-atom margin", async () => {
    const { provider } = fakeModels({ "13C": { 0: 18.5, 1: 58 } });
    const predictor = new GnnShiftPredictor({ models: provider, hose: stubHose([]) });
    const result = await predictor.predict(smiles("CCO"));
    expect(byAtoms(result, "13C", [0])).toMatchObject({ method: "GNN prediction", tier: "medium" });
    expect(byAtoms(result, "13C", [0])?.reference).toBeUndefined();
  });

  it("a rule estimate is not a HOSE match: tier by margin, no disagreement however far apart", async () => {
    const { provider } = fakeModels({ "13C": { 0: 18.5 } });
    const predictor = new GnnShiftPredictor({ models: provider, hose: stubHose([ruleEstimate("13C", [0], 40)]) });
    const result = await predictor.predict(smiles("CCO"));
    expect(byAtoms(result, "13C", [0])).toMatchObject({ method: "GNN prediction", tier: "medium", deltaPpm: 18.5 });
    expect(byAtoms(result, "13C", [0])?.disagreesWithReference).toBeUndefined();
    expect(codes(result)).not.toContain(NmrWarningCodes.ModelLookupDisagreement);
  });

  it("low: no HOSE match and a neighbor below the 500-atom margin (S⁺ has 44 training atoms)", async () => {
    // Trimethylsulfonium: carbon classes [0, 2, 3]; the S⁺ neighbor's (charge 1, no radical) state is
    // above the decline minimum of 20 but below the 500-atom margin.
    expect(GNN_TRAINING_DOMAIN.charge_states.S["1:none"]).toBeGreaterThanOrEqual(20);
    expect(GNN_TRAINING_DOMAIN.charge_states.S["1:none"]).toBeLessThan(500);
    const { provider } = fakeModels({ "13C": { 0: 27, 2: 27, 3: 27 } });
    const predictor = new GnnShiftPredictor({ models: provider, hose: stubHose([]) });
    const result = await predictor.predict(smiles("C[S+](C)C"));
    expect(byAtoms(result, "13C", [0, 2, 3])).toMatchObject({ method: "GNN prediction", tier: "low" });
  });

  it("a HOSE match decides the tier whatever the margin (as py/abstention.py tier())", async () => {
    const { provider } = fakeModels({ "13C": { 0: 27, 2: 27, 3: 27 } });
    const predictor = new GnnShiftPredictor({ models: provider, hose: stubHose([hoseMatch("13C", [0, 2, 3], 26, 3)]) });
    expect(byAtoms(await predictor.predict(smiles("C[S+](C)C")), "13C", [0, 2, 3])?.tier).toBe("high");
  });
});

describe("GnnShiftPredictor disagreement (ABSTENTION.md section 4)", () => {
  it("reports the GNN value with tier low, both values, and the prescribed warning, never an average", async () => {
    const { provider } = fakeModels({ "13C": { 0: 30, 1: 58 } });
    const predictor = new GnnShiftPredictor({ models: provider, hose: stubHose([hoseMatch("13C", [0], 18, 4), hoseMatch("13C", [1], 58, 4)]) });
    const result = await predictor.predict(smiles("CCO"));
    const resonance = byAtoms(result, "13C", [0]);
    expect(resonance).toMatchObject({
      method: "GNN prediction",
      source: "model",
      tier: "low",
      deltaPpm: 30,
      disagreesWithReference: true,
      reference: { method: "HOSE lookup", deltaPpm: 18, matchedSphere: 4 }
    });
    expect(resonance?.flags).toContain("model-lookup-disagreement");
    const warning = result.warnings.find((item) => item.code === NmrWarningCodes.ModelLookupDisagreement);
    expect(warning?.message).toContain(MODEL_LOOKUP_DISAGREEMENT_PHRASE);
    expect(warning?.message).toContain("30.00");
    expect(warning?.message).toContain("18.00");
    expect(warning?.atomIndices).toEqual([0]);
    expect(warning?.details).toMatchObject({ nucleus: "13C", gnnPpm: 30, lookupPpm: 18, bandPpm: 4 });
    // The agreeing CH2 carries no warning.
    expect(result.warnings.filter((item) => item.code === NmrWarningCodes.ModelLookupDisagreement)).toHaveLength(1);
    expect(byAtoms(result, "13C", [1])?.tier).toBe("high");
  });

  it("uses the ¹H band of 0.65 ppm for proton resonances", async () => {
    expect(GNN_AGREEMENT_BANDS["1H"]).toBe(0.65);
    const { provider } = fakeModels({ "1H": { 0: 1.2 + 0.7, 1: 3.6 + 0.6 } });
    const predictor = new GnnShiftPredictor({
      models: provider,
      hose: stubHose([hoseMatch("1H", [0], 1.2, 3), hoseMatch("1H", [1], 3.6, 3)])
    });
    const result = await predictor.predict(smiles("CCO", ["1H"]));
    expect(byAtoms(result, "1H", [0])).toMatchObject({ tier: "low", disagreesWithReference: true });
    expect(byAtoms(result, "1H", [1])).toMatchObject({ tier: "high" });
  });
});

describe("GnnShiftPredictor declines (ABSTENTION.md section 1) and fallback (section 2)", () => {
  it("rule 1, element: an 'other' element on a heavy neighbor declines; the HOSE value is shown", async () => {
    const { provider } = fakeModels({ "13C": { 0: 10, 4: 10, 6: 10, 8: 10, 1: 5, 3: 5, 5: 5, 7: 5 } });
    const hose = stubHose([hoseMatch("13C", [1, 3, 5, 7], 2.5, 2), hoseMatch("13C", [0, 4, 6, 8], 10.5, 3)]);
    const result = await new GnnShiftPredictor({ models: provider, hose }).predict(smiles("CC[Sn](CC)(CC)CC"));
    expect(byAtoms(result, "13C", [1, 3, 5, 7])).toMatchObject({ method: "HOSE lookup", deltaPpm: 2.5, modelDeclines: ["element"] });
    expect(byAtoms(result, "13C", [0, 4, 6, 8])).toMatchObject({ method: "GNN prediction", deltaPpm: 10 });
    const declined = result.warnings.find((warning) => warning.code === NmrWarningCodes.GnnDeclined);
    expect(declined?.message).toContain("rule 1");
    expect(declined?.atomIndices).toEqual([1, 3, 5, 7]);
    expect(declined?.details).toMatchObject({ nucleus: "13C", rules: ["element"] });
  });

  it("rule 1, element: fewer than 50 training atoms declines; exactly 50 does not", async () => {
    const withSelenium = (count: number): GnnTrainingDomain => ({
      ...GNN_TRAINING_DOMAIN,
      elements: { ...GNN_TRAINING_DOMAIN.elements, Se: count }
    });
    const request = smiles("c1cc[se]c1");
    const rare = await new GnnShiftPredictor({ models: fakeModels().provider, hose: stubHose([]), domain: withSelenium(49) }).predict(request);
    const known = await new GnnShiftPredictor({ models: fakeModels().provider, hose: stubHose([]), domain: withSelenium(50) }).predict(request);
    // The carbons next to Se are declined only below the minimum; the far carbons never are.
    expect(rare.warnings.find((warning) => warning.code === NmrWarningCodes.GnnDeclined)?.details).toMatchObject({ rules: ["element"] });
    expect(known.warnings.some((warning) => warning.code === NmrWarningCodes.GnnDeclined)).toBe(false);
    expect(known.resonances.every((resonance) => resonance.method === "GNN prediction")).toBe(true);
  });

  it("rule 2, charge/radical: a radical state absent from training declines the atom and its neighbors", async () => {
    const { provider, runs } = fakeModels({ "13C": { 0: 15, 1: 20 } });
    const result = await new GnnShiftPredictor({ models: provider, hose: stubHose([hoseMatch("13C", [0], 13.9, 2)]) })
      .predict(fixtureMolfile("ethyl radical"));
    expect(byAtoms(result, "13C", [0])).toMatchObject({ method: "HOSE lookup", deltaPpm: 13.9, modelDeclines: ["charge_radical"] });
    // No HOSE value for the radical carbon: no shift.
    expect(byAtoms(result, "13C", [1])).toBeUndefined();
    expect(runs).toHaveLength(0); // everything declined: the model is not run
    expect(result.warnings.find((warning) => warning.code === NmrWarningCodes.GnnDeclined)?.message).toContain("rule 2");
  });

  it("rule 2, charge/radical: fewer than 20 training atoms of the state declines; exactly 20 does not", async () => {
    const withNeutralCarbon = (count: number): GnnTrainingDomain => ({
      ...GNN_TRAINING_DOMAIN,
      charge_states: { ...GNN_TRAINING_DOMAIN.charge_states, C: { ...GNN_TRAINING_DOMAIN.charge_states.C, "0:none": count } }
    });
    const rare = await new GnnShiftPredictor({ models: fakeModels().provider, hose: stubHose([]), domain: withNeutralCarbon(19) }).predict(smiles("CC"));
    const known = await new GnnShiftPredictor({ models: fakeModels().provider, hose: stubHose([]), domain: withNeutralCarbon(20) }).predict(smiles("CC"));
    expect(rare.resonances).toEqual([]);
    expect(rare.warnings.find((warning) => warning.code === NmrWarningCodes.GnnDeclined)?.details).toMatchObject({ rules: ["charge_radical"] });
    // 20 passes the decline but not the 500-atom margin: no HOSE match → tier low.
    expect(known.resonances).toEqual([expect.objectContaining({ method: "GNN prediction", tier: "low" })]);
  });

  it("rule 3, isotope: ¹⁵N on a neighbor and folded tritium decline; ¹³C and ²H do not", async () => {
    const aniline = await new GnnShiftPredictor({ models: fakeModels().provider, hose: stubHose([]) })
      .predict(fixtureMolfile("aniline-15N (declined: isotope)"));
    const declined = aniline.warnings.find((warning) => warning.code === NmrWarningCodes.GnnDeclined);
    expect(declined?.details).toMatchObject({ rules: ["isotope"] });
    expect(declined?.atomIndices).toEqual([1]); // only the carbon bonded to ¹⁵N
    const tritium = await new GnnShiftPredictor({ models: fakeModels().provider, hose: stubHose([]) })
      .predict(fixtureMolfile("tritiomethane (declined: isotope)"));
    expect(tritium.warnings.find((warning) => warning.code === NmrWarningCodes.GnnDeclined)?.details).toMatchObject({ rules: ["isotope"] });
    for (const name of ["methanol-13C", "chloroform-d"]) {
      const allowed = await new GnnShiftPredictor({ models: fakeModels().provider, hose: stubHose([]) }).predict(fixtureMolfile(name));
      expect(allowed.warnings.some((warning) => warning.code === NmrWarningCodes.GnnDeclined), name).toBe(false);
      expect(allowed.resonances.map((resonance) => resonance.method), name).toEqual(["GNN prediction"]);
    }
  });

  it("rule 4, size: more heavy atoms than the training size limit declines every atom", async () => {
    expect(GNN_TRAINING_DOMAIN.size_limit).toBe(103);
    const { provider, runs } = fakeModels();
    const result = await new GnnShiftPredictor({ models: provider }).predict(fixtureMolfile("C110 alkane (declined: size)"));
    expect(runs).toHaveLength(0);
    expect(result.resonances.length).toBeGreaterThan(0);
    expect(result.resonances.every((resonance) => resonance.method === "HOSE lookup" && resonance.modelDeclines?.[0] === "size")).toBe(true);
    const larger = await new GnnShiftPredictor({
      models: fakeModels().provider,
      hose: stubHose([]),
      domain: { ...GNN_TRAINING_DOMAIN, size_limit: 110 }
    }).predict(fixtureMolfile("C110 alkane (declined: size)"));
    expect(larger.resonances.length).toBeGreaterThan(0);
    expect(larger.resonances.every((resonance) => resonance.method === "GNN prediction")).toBe(true);
  }, 60_000);

  it("no shift when both the GNN declines and the HOSE lookup has no match (nothing is fabricated)", async () => {
    const omitted = nmrWarning(NmrWarningCodes.NoFragmentMatch, "No 13C database match for atoms 1; omitted.", {
      atomIndices: [1],
      details: { nucleus: "13C" }
    });
    const partial = nmrWarning(NmrWarningCodes.PartialPrediction, "1 unmatched atom environment(s) were omitted because no applicable rule estimate exists.", {
      details: { omittedEnvironmentCount: 1 }
    });
    const result = await new GnnShiftPredictor({
      models: fakeModels().provider,
      hose: stubHose([hoseMatch("13C", [0], 13.9, 2)], [omitted, partial])
    }).predict(fixtureMolfile("ethyl radical"));
    expect(result.resonances.map((resonance) => resonance.atomRefs[0].sourceAtomIndex)).toEqual([0]);
    expect(codes(result)).toEqual(expect.arrayContaining([NmrWarningCodes.NoFragmentMatch, NmrWarningCodes.PartialPrediction]));
    expect(result.warnings.find((warning) => warning.code === NmrWarningCodes.GnnDeclined)?.message).toContain("no shift is shown");
  });

  it("falls back to the HOSE engine's own result, unchanged but labeled, when the model fails its checksum", async () => {
    const runtime = new GnnModelRuntime({ fetchAsset: readAsset, expectedSha256: () => "f".repeat(64) });
    const request = smiles("CC(=O)OCC");
    const gnn = await new GnnShiftPredictor({ models: runtime, now: () => "t" }).predict(request);
    const hose = await new OclHosePredictor({ now: () => "t" }).predict(request);
    expect(gnn.resonances).toEqual(hose.resonances.map((resonance) => ({ ...resonance, method: "HOSE lookup" })));
    expect(gnn.warnings.slice(0, hose.warnings.length)).toEqual(hose.warnings);
    const unavailable = gnn.warnings.find((warning) => warning.code === NmrWarningCodes.GnnModelUnavailable);
    expect(unavailable?.details).toEqual({ nucleus: "13C", reason: "checksum-mismatch" });
    expect(gnn.backend.method).toBe("hose-fragment");
    expect(gnn.backend.model).toBeUndefined();
    expect(NmrPredictionResultSchema.safeParse(gnn).success).toBe(true);
  });

  it("falls back to the HOSE lookup when inference fails", async () => {
    const failing: GnnModelProvider = {
      load: async (nucleus) => ({
        status: "ready",
        model: { nucleus, sha256: "x", run: async () => { throw new Error("out of memory"); } }
      })
    };
    const result = await new GnnShiftPredictor({ models: failing, hose: stubHose([hoseMatch("13C", [0], 18, 3)]) }).predict(smiles("CCO"));
    expect(result.resonances).toEqual([expect.objectContaining({ method: "HOSE lookup", deltaPpm: 18 })]);
    expect(codes(result)).toContain(NmrWarningCodes.GnnInferenceFailed);
  });
});

describe("GnnShiftPredictor labels and notices", () => {
  it("labels every resonance GNN prediction or HOSE lookup, and keeps fallback evidence intact", async () => {
    const { provider } = fakeModels({ "13C": { 0: 10, 4: 10, 6: 10, 8: 10 } });
    const result = await new GnnShiftPredictor({ models: provider, now: () => "t" }).predict(smiles("CC[Sn](CC)(CC)CC"));
    expect(result.resonances.length).toBeGreaterThan(0);
    for (const resonance of result.resonances) {
      expect(["GNN prediction", "HOSE lookup"]).toContain(resonance.method);
      if (resonance.method === "GNN prediction") {
        expect(resonance).toMatchObject({ source: "model", evidence: { method: "gnn" } });
        expect(["high", "medium", "low"]).toContain(resonance.tier);
        expect(resonance.uncertainty).toBeUndefined();
      } else {
        expect(resonance.tier).toBeUndefined();
        expect(["lookup", "rule-estimate"]).toContain(resonance.source);
      }
    }
    expect(result.backend).toMatchObject({ id: "chemdraft.gnn-hose", method: "gnn", model: { id: "chemdraft.gnn-shift", nuclei: ["13C"] } });
    expect(NmrPredictionResultSchema.safeParse(result).success).toBe(true);
    // No calibrated probabilities anywhere in the result.
    expect(JSON.stringify(result)).not.toMatch(/%|probabilit|confidence interval/i);
  });

  it("drops HOSE notices about resonances the GNN replaced and keeps those about what is shown", async () => {
    const request = smiles("CC[Sn](CC)(CC)CC");
    const hose = await new OclHosePredictor({ now: () => "t" }).predict(request);
    // The HOSE engine matched the methyls only at sphere 1 and found nothing for the Sn-bound CH2.
    expect(hose.warnings.some((warning) => warning.code === NmrWarningCodes.LowHoseSphereMatch && warning.atomIndices?.join() === "0,4,6,8")).toBe(true);
    const { provider } = fakeModels({ "13C": { 0: 10, 4: 10, 6: 10, 8: 10 } });
    const result = await new GnnShiftPredictor({ models: provider, now: () => "t" }).predict(request);
    expect(byAtoms(result, "13C", [0, 4, 6, 8])?.method).toBe("GNN prediction");
    expect(result.warnings.some((warning) => warning.code === NmrWarningCodes.LowHoseSphereMatch && warning.atomIndices?.join() === "0,4,6,8")).toBe(false);
    // The declined CH2 has no shift at all: the omission notices stay, recounted.
    expect(byAtoms(result, "13C", [1, 3, 5, 7])).toBeUndefined();
    expect(result.warnings.find((warning) => warning.code === NmrWarningCodes.NoFragmentMatch)?.atomIndices).toEqual([1, 3, 5, 7]);
    expect(result.warnings.find((warning) => warning.code === NmrWarningCodes.PartialPrediction)?.details).toEqual({ omittedEnvironmentCount: 4 });
  });

  it("recounts the rule-estimate summary over the estimates still shown", async () => {
    const summary = nmrWarning(NmrWarningCodes.RuleEstimated, "2 resonance(s) had no database match ...", { atomIndices: [0, 1] });
    const { provider } = fakeModels({ "13C": { 0: 18, 1: 58 } });
    const result = await new GnnShiftPredictor({
      models: provider,
      hose: stubHose([ruleEstimate("13C", [0], 15), ruleEstimate("13C", [1], 60)], [summary]),
      domain: { ...GNN_TRAINING_DOMAIN, elements: { ...GNN_TRAINING_DOMAIN.elements, O: 10 } }
    }).predict(smiles("CCO"));
    // O is rare in this domain: the CH2 next to it falls back to its rule estimate; the CH3 does not.
    expect(byAtoms(result, "13C", [1])).toMatchObject({ method: "HOSE lookup", source: "rule-estimate" });
    expect(byAtoms(result, "13C", [0])).toMatchObject({ method: "GNN prediction" });
    const recounted = result.warnings.find((warning) => warning.code === NmrWarningCodes.RuleEstimated);
    expect(recounted?.message).toMatch(/^1 resonance\(s\) had no database match .*13C atoms 1\./);
    expect(recounted?.atomIndices).toEqual([1]);
  });

  it("omits labile protons the request did not ask for, as the HOSE engine does", async () => {
    const { provider, runs } = fakeModels({ "1H": { 0: 1.2, 1: 3.6, 2: 2 } });
    const result = await new GnnShiftPredictor({ models: provider, now: () => "t" }).predict(smiles("CCO", ["1H"]));
    expect(result.resonances.map((resonance) => resonance.atomRefs.map((ref) => ref.sourceAtomIndex).join())).toEqual(["0", "1"]);
    expect(runs).toHaveLength(1);
  });
});

describe("GnnShiftPredictor and ³¹P", () => {
  it("leaves ³¹P to the HOSE lookup and never loads a model for it", async () => {
    const { provider, loads } = fakeModels();
    const request = smiles("CCP(CC)CC", ["31P"]);
    const gnn = await new GnnShiftPredictor({ models: provider, now: () => "t" }).predict(request);
    const hose = await new OclHosePredictor({ now: () => "t" }).predict(request);
    expect(loads).toEqual([]);
    expect(gnn).toEqual({ ...hose, resonances: hose.resonances.map((resonance) => ({ ...resonance, method: "HOSE lookup" })) });
  });

  it("keeps ³¹P resonances identical in a mixed ¹³C + ³¹P request", async () => {
    const { provider, loads } = fakeModels({ "13C": { 0: 10, 1: 20 } });
    const request = smiles("CCP(CC)CC", ["13C", "31P"]);
    const gnn = await new GnnShiftPredictor({ models: provider, now: () => "t" }).predict(request);
    const hose = await new OclHosePredictor({ now: () => "t" }).predict(request);
    expect(loads).toEqual(["13C"]);
    expect(gnn.resonances.filter((resonance) => resonance.nucleus === "31P")).toEqual(
      hose.resonances.filter((resonance) => resonance.nucleus === "31P").map((resonance) => ({ ...resonance, method: "HOSE lookup" }))
    );
    expect(gnn.backend.phosphorusDatabase).toEqual(hose.backend.phosphorusDatabase);
  });
});

describe("GnnShiftPredictor lazy loading", () => {
  it("loads no model at plugin start or for capabilities, and only the requested nucleus on first use", async () => {
    const fetched: string[] = [];
    let ortImports = 0;
    const runtime = new GnnModelRuntime({
      fetchAsset: async (url) => {
        fetched.push(url.pathname.split("/").pop() ?? "");
        return readAsset(url);
      },
      loadOrt: async () => {
        ortImports += 1;
        return (await import("onnxruntime-web/wasm")) as never;
      }
    });
    const responses: NmrWorkerResponse[] = [];
    const handle = createNmrWorkerHandler((response) => responses.push(response), {
      createPredictor: () => new GnnShiftPredictor({ models: runtime })
    });
    const settled = async (requestId: string) => {
      for (let i = 0; i < 2000 && !responses.some((response) => response.requestId === requestId); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return responses.find((response) => response.requestId === requestId);
    };

    handle({ type: "initialize", requestId: "i", providerId: "chemdraft.ocl-hose" });
    expect(await settled("i")).toMatchObject({ type: "ready", capabilities: { id: "chemdraft.gnn-hose" } });
    expect(fetched).toEqual([]);
    expect(ortImports).toBe(0);

    handle({ type: "predict", requestId: "p31", request: smiles("CCP(CC)CC", ["31P"]) });
    expect((await settled("p31"))?.type).toBe("result");
    expect(fetched).toEqual([]);
    expect(ortImports).toBe(0);

    handle({ type: "predict", requestId: "c13", request: smiles("CC(=O)OCC") });
    const carbon = await settled("c13");
    expect(carbon?.type).toBe("result");
    expect(fetched).toEqual(["13C.fp16.onnx"]);
    expect(ortImports).toBe(1);
    if (carbon?.type === "result") {
      expect(carbon.result.resonances.every((resonance) => resonance.method === "GNN prediction")).toBe(true);
    }

    handle({ type: "predict", requestId: "c13-again", request: smiles("Cc1ccccc1") });
    await settled("c13-again");
    expect(fetched).toEqual(["13C.fp16.onnx"]);
  }, 60_000);
});

describe("GnnShiftPredictor with the bundled models", () => {
  it("predicts ¹H and ¹³C through ONNX Runtime Web with tiers and HOSE references", async () => {
    const predictor = new GnnShiftPredictor({ models: new GnnModelRuntime({ fetchAsset: readAsset }), now: () => "t" });
    const carbon = await predictor.predict(smiles("CC(=O)OCC"));
    const proton = await predictor.predict(smiles("CC(=O)OCC", ["1H"]));
    for (const result of [carbon, proton]) {
      expect(result.resonances.length).toBeGreaterThan(0);
      expect(result.resonances.every((resonance) => resonance.method === "GNN prediction" && resonance.tier !== undefined)).toBe(true);
      expect(NmrPredictionResultSchema.safeParse(result).success).toBe(true);
    }
    // Ethyl acetate: the carbonyl carbon is near 171 ppm and the O–CH2 protons near 4.1 ppm.
    const carbonyl = byAtoms(carbon, "13C", [1]);
    expect(carbonyl?.deltaPpm).toBeGreaterThan(165);
    expect(carbonyl?.deltaPpm).toBeLessThan(176);
    const methylene = byAtoms(proton, "1H", [4]);
    expect(methylene?.deltaPpm).toBeGreaterThan(3.8);
    expect(methylene?.deltaPpm).toBeLessThan(4.4);
  }, 60_000);
});
