import * as OCL from "openchemlib";
import { describe, expect, it } from "vitest";

import type { NmrPredictionResult } from "../domain/contracts";
import { firstOrderLines } from "../domain/firstOrderCoupling";
import { NmrWarningCodes } from "../domain/warnings";
import { OclHosePredictor } from "../providers/ocl/OclHosePredictor";
import { prepareProductionLookup, productionEnvironmentCodes } from "../providers/ocl/productionLookup";
import { estimateProtonIncrement } from "../providers/ocl/incrementEstimator";
import { estimateCarbonShiftWithApplicability } from "../providers/ocl/functionalGroupFallback";

// ChemDraft canvas-style V2000: planar coordinates, Kekule bonds, implicit ordinary H,
// and explicit H atoms with M ISO mass 2. Deliberately not serialized through OCL.
function hostMolfile(elements: string[], bonds: number[][], deuteriums: number[] = []) {
  const field = (value: number) => String(value).padStart(3);
  return [
    "Host isotope regression", "  ChemDraft  2D", "",
    `${field(elements.length)}${field(bonds.length)}  0  0  0  0            999 V2000`,
    ...elements.map((element, atom) =>
      `${(atom * 1.4).toFixed(4).padStart(10)}    0.0000    0.0000 ${element.padEnd(3)} 0  0  0  0  0  0  0  0  0  0  0  0`),
    ...bonds.map(([a, b, order]) => `${field(a)}${field(b)}${field(order)}  0  0  0  0`),
    ...(deuteriums.length ? [`M  ISO${field(deuteriums.length)}${deuteriums.map((atom) => `${String(atom).padStart(4)}   2`).join("")}`] : []),
    "M  END"
  ].join("\n");
}

const ethanol = hostMolfile(["C", "C", "O"], [[1, 2, 1], [2, 3, 1]]);
const ethanolOD = hostMolfile(["C", "C", "O", "H"], [[1, 2, 1], [2, 3, 1], [3, 4, 1]], [4]);
const methanolCD3 = hostMolfile(["C", "O", "H", "H", "H"],
  [[1, 2, 1], [1, 3, 1], [1, 4, 1], [1, 5, 1]], [3, 4, 5]);
const methylamineNHD = hostMolfile(["C", "N", "H"], [[1, 2, 1], [2, 3, 1]], [3]);
const ring = [[1, 2, 2], [2, 3, 1], [3, 4, 2], [4, 5, 1], [5, 6, 2], [6, 1, 1]];
const benzene = hostMolfile(Array(6).fill("C"), ring);
const benzeneD5 = hostMolfile([...Array(6).fill("C"), ...Array(5).fill("H")],
  [...ring, [2, 7, 1], [3, 8, 1], [4, 9, 1], [5, 10, 1], [6, 11, 1]], [7, 8, 9, 10, 11]);
const predictor = new OclHosePredictor({ now: () => "t" });
const fallback = new OclHosePredictor({ database: { provenance: predictor.provenance, entries: {} } });
const options = { statistic: "median" as const, hoseLevels: [4, 3, 2, 1], ignoreLabileHydrogens: false };

function predict(value: string, provider = predictor) {
  return provider.predict({ structure: { format: "molfile-v2000", value },
    nuclei: ["1H", "13C"], options, sourceFingerprint: "regression" });
}

function protons(result: NmrPredictionResult) {
  return result.resonances.filter((resonance) => resonance.nucleus === "1H");
}

function assertFirstOrderDisclosure(result: NmrPredictionResult) {
  expect(result.warnings.map((warning) => warning.code)).not.toContain(NmrWarningCodes.IsotopeNotSupported);
  expect(result.warnings.find((warning) => warning.code === NmrWarningCodes.DeuteriumShiftNotModelled))
    .toMatchObject({ message: expect.stringContaining("treated as hydrogen for database environment matching and rule estimates") });
  expect(result.warnings.find((warning) => warning.code === NmrWarningCodes.DeuteriumShiftNotModelled)?.message)
    .toContain("isotope shifts are not modelled (first-order)");
}

describe("deuterated host molfile environments", () => {
  it("CH3CH2OD keeps both C–H environments and drops only OH", async () => {
    const plain = await predict(ethanol);
    const result = await predict(ethanolOD);
    expect(protons(plain).map((r) => r.equivalentNuclei).sort()).toEqual([1, 2, 3]);
    expect(protons(result)).toHaveLength(2);
    expect(protons(result).map((r) => r.equivalentNuclei).sort()).toEqual([2, 3]);
    for (const host of [0, 1]) {
      const atHost = (prediction: NmrPredictionResult) => protons(prediction).find((r) =>
        r.atomRefs.some((ref) => ref.sourceAtomIndex === host))!;
      expect(atHost(result)).toBeDefined();
      expect(Math.abs(atHost(result).deltaPpm - atHost(plain).deltaPpm)).toBeLessThan(0.01);
      expect(atHost(result).source).toBe(atHost(plain).source);
      expect(atHost(result).atomRefs).toEqual(atHost(plain).atomRefs);
    }
    expect(protons(result).flatMap((r) => r.atomRefs.map((ref) => ref.sourceAtomIndex)).sort()).toEqual([0, 1]);
    assertFirstOrderDisclosure(result);
  });

  it("CD3OH has no ¹H resonances and warns about unmatched OH", async () => {
    const result = await predict(methanolCD3);
    const plain = await predict(hostMolfile(["C", "O"], [[1, 2, 1]]));
    expect(protons(result)).toHaveLength(0);
    const unmatchedOH = plain.warnings.find((warning) => warning.code === NmrWarningCodes.PartialPrediction);
    expect(unmatchedOH).toBeDefined();
    expect(result.warnings.map((warning) => warning.code)).toContain(unmatchedOH!.code);
    assertFirstOrderDisclosure(result);
  });

  it("CD3OH predicts the methyl carbon without C–D splitting", async () => {
    const result = await predict(methanolCD3);
    const plain = await predict(hostMolfile(["C", "O"], [[1, 2, 1]]));
    expect(protons(result).some((r) => r.atomRefs.some((ref) => ref.sourceAtomIndex === 0))).toBe(false);
    const carbons = result.resonances.filter((r) => r.nucleus === "13C");
    expect(carbons).toHaveLength(1);
    expect(carbons[0].deltaPpm).toBe(plain.resonances.find((r) => r.nucleus === "13C")?.deltaPpm);
    expect(carbons[0].equivalentNuclei).toBe(1);
    expect(carbons[0].multiplet).toBeUndefined();
    expect(result.warnings.find((w) => w.code === NmrWarningCodes.CarbonDeuteriumSplittingNotModelled))
      .toMatchObject({ atomIndices: [0], message: expect.stringContaining("C–D splitting and isotope shifts are not modelled") });
    assertFirstOrderDisclosure(result);
  });

  it("C6D5H retains one benzene-like proton with estimated ortho H–D coupling and all six carbons", async () => {
    const result = await predict(benzeneD5);
    const plain = await predict(benzene);
    expect(protons(result)).toHaveLength(1);
    const proton = protons(result)[0];
    expect(proton.equivalentNuclei).toBe(1);
    expect(proton.atomRefs).toMatchObject([{ sourceAtomIndex: 0, equivalentCount: 1 }]);
    expect(proton.deltaPpm).toBe(protons(plain)[0].deltaPpm);
    expect(proton.deltaPpm).toBeGreaterThan(7);
    expect(proton.deltaPpm).toBeLessThan(8);
    expect(proton.multiplet).toMatchObject({ label: "quint", couplings: [
      { partnerNucleus: "2H", kind: "aromatic-ortho", partnerCount: 2, jHz: 7.8 * 0.1535 }
    ] });
    expect(firstOrderLines(proton.multiplet!.couplings).map((line) => Math.round(line.intensity * 9)))
      .toEqual([1, 2, 3, 2, 1]);
    expect(result.warnings.find((w) => w.code === NmrWarningCodes.DeuteriumShiftNotModelled)?.message)
      .toContain("H–D couplings are typical first-order estimates");
    const carbons = result.resonances.filter((r) => r.nucleus === "13C");
    expect(carbons.reduce((sum, r) => sum + r.equivalentNuclei, 0)).toBe(6);
    expect(carbons.flatMap((r) => r.atomRefs.map((ref) => ref.sourceAtomIndex)).sort()).toEqual([0, 1, 2, 3, 4, 5]);
    for (const carbon of carbons) expect(carbon.deltaPpm).toBe(plain.resonances.find((r) => r.nucleus === "13C")?.deltaPpm);
    assertFirstOrderDisclosure(result);
  });

  it.each([["CH3CH2OD", ethanolOD], ["CD3OH", methanolCD3], ["C6D5H", benzeneD5], ["CH3NHD", methylamineNHD]])
  ("matches database codes and rule applicability as if each D were H: %s", (_name, molfile) => {
    const original = OCL.Molecule.fromMolfile(molfile);
    original.ensureHelperArrays(OCL.Molecule.cHelperRings);
    const parent = original.getCompactCopy();
    for (let atom = 0; atom < parent.getAllAtoms(); atom += 1) {
      if (parent.getAtomicNo(atom) === 1) parent.setAtomMass(atom, 0);
    }
    parent.removeExplicitHydrogens();
    const deuterated = prepareProductionLookup(original);
    const hydrogenated = prepareProductionLookup(parent);
    for (let atom = 0; atom < parent.getAllAtoms(); atom += 1) {
      if (parent.getAtomicNo(atom) === 1) continue;
      expect(productionEnvironmentCodes(deuterated, atom)).toEqual(productionEnvironmentCodes(hydrogenated, atom));
      for (const estimate of [estimateProtonIncrement, estimateCarbonShiftWithApplicability]) {
        expect(estimate(deuterated._shiftMolecule, deuterated._inputToShift[atom])).toEqual(estimate(parent, atom));
      }
    }
  });

  it("falls back to the same C–H and carbon estimates when the database has no match for CH3CH2OD", async () => {
    const plain = await predict(ethanol, fallback);
    const result = await predict(ethanolOD, fallback);
    expect(protons(result)).toHaveLength(2);
    expect(protons(result).map((r) => r.deltaPpm).sort()).toEqual(protons(plain).map((r) => r.deltaPpm).sort());
    expect(result.resonances.every((r) => r.source === "rule-estimate")).toBe(true);
    expect(result.resonances.filter((r) => r.nucleus === "13C").map((r) => r.deltaPpm).sort())
      .toEqual(plain.resonances.filter((r) => r.nucleus === "13C").map((r) => r.deltaPpm).sort());
    assertFirstOrderDisclosure(result);
  });

  it.each(["[13CH3]CO[2H]", "C[15NH][2H]", "CCO[3H]"])(
    "retains rule refusal for other isotopes: %s", async (smiles) => {
      const result = await predict(OCL.Molecule.fromSmiles(smiles).toMolfile(), fallback);
      expect(result.resonances).toEqual([]);
      expect(result.warnings.map((w) => w.code)).toContain(NmrWarningCodes.IsotopeNotSupported);
      expect(result.warnings.some((w) => w.details?.estimateInapplicableReason === "isotopically-labeled-structure"))
        .toBe(true);
    }
  );
});
