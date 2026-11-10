import { createHash } from "node:crypto";
import { PluginPanelReportSchema } from "@chemdraft/plugin-api";
import type { PluginLinkedFigurePeak } from "@chemdraft/plugin-api";
import * as OCL from "openchemlib";
import { describe, expect, it } from "vitest";

import type { ChemicalStructureInput, NmrNucleus, NmrPredictionResult } from "../domain/contracts";
import { DEUTERIUM_PROTON_GYROMAGNETIC_RATIO, firstOrderLines } from "../domain/firstOrderCoupling";
import { NmrPredictionResultSchema } from "../domain/schemas";
import { NmrWarningCodes } from "../domain/warnings";
import { computeMultiplet, reportedProtonCouplingHz } from "../providers/ocl/coupling";
import { OclHosePredictor } from "../providers/ocl/OclHosePredictor";
import { composePredictionReport } from "../report/composePredictionReport";
import { renderStickSpectrumSvg } from "../report/stickSpectrumSvg";
import baselines from "./fixtures/noDeuteriumOutput.json";

const options = { statistic: "median" as const, hoseLevels: [4, 3, 2, 1], ignoreLabileHydrogens: true };
const predictor = new OclHosePredictor({ now: () => "t" });

function predict(value: string, nuclei: readonly NmrNucleus[] = ["1H", "13C"], format: ChemicalStructureInput["format"] = "smiles") {
  return predictor.predict({ structure: { format, value }, nuclei, options, sourceFingerprint: "regression" });
}

function resonanceAt(result: NmrPredictionResult, atom: number, nucleus: NmrNucleus = "1H") {
  const resonance = result.resonances.find((candidate) =>
    candidate.nucleus === nucleus && candidate.atomRefs.some((ref) => ref.sourceAtomIndex === atom));
  if (!resonance) throw new Error(`Missing ${nucleus} resonance at host ${atom}`);
  return resonance;
}

function reportFor(result: NmrPredictionResult, structure: ChemicalStructureInput = { format: "smiles", value: "CCO" }) {
  return composePredictionReport({
    objectId: "m1", structureFormat: structure.format, structure: structure.value, sourceFingerprint: "regression"
  }, result);
}

function molfileFor(smiles: string, encoding: "D" | "ISO") {
  const molecule = OCL.Molecule.fromSmiles(smiles);
  molecule.ensureHelperArrays(OCL.Molecule.cHelperRings);
  const lines = molecule.toMolfile().split("\n");
  if (encoding === "ISO") return lines.join("\n");
  for (let atom = 0; atom < molecule.getAllAtoms(); atom += 1) {
    if (molecule.getAtomicNo(atom) === 1 && molecule.getAtomMass(atom) === 2) {
      const line = lines[4 + atom];
      lines[4 + atom] = `${line.slice(0, 31)}D  ${line.slice(34)}`;
    }
  }
  return lines.filter((line) => !line.startsWith("M  ISO")).join("\n");
}

function relativeIntensities(lines: ReturnType<typeof firstOrderLines>) {
  return lines.map((line) => Math.round(line.intensity / lines[0].intensity));
}

// Reference the current host contract: binomial splitting in ppm, with each component normalized
// to its tallest line (not to total area). This deliberately does not use firstOrderLines().
function hostLines(peaks: readonly PluginLinkedFigurePeak[], fieldMHz: number, alternative = false) {
  return peaks.flatMap((peak) => {
    let lines = [{ ppm: alternative ? peak.alternativePpm! : peak.ppm, intensity: 1 }];
    for (const { jHz, partnerCount: n } of peak.couplings ?? []) {
      const weights = Array.from({ length: n + 1 }, (_, k) => {
        let weight = 1;
        for (let i = 0; i < k; i += 1) weight = weight * (n - i) / (i + 1);
        return weight;
      });
      lines = lines.flatMap((line) => weights.map((weight, k) => ({
        ppm: line.ppm + (k - n / 2) * jHz / fieldMHz,
        intensity: line.intensity * weight
      })));
    }
    const max = Math.max(...lines.map((line) => line.intensity));
    return lines.map((line) => ({ ...line, intensity: peak.intensity * line.intensity / max }));
  }).sort((a, b) => a.ppm - b.ppm);
}

function figureFor(result: NmrPredictionResult) {
  const figure = reportFor(result).sections.find((section) => section.kind === "linkedFigure");
  if (!figure || figure.kind !== "linkedFigure") throw new Error("Missing linked figure");
  return figure;
}

describe("first-order ¹H–²H coupling", () => {
  it.each([
    ["CC([2H])(Cl)Cl", "t", [1, 1, 1]],
    ["CC([2H])([2H])O", "quint", [1, 2, 3, 2, 1]],
    ["CC([2H])([2H])[2H]", "sept", [1, 3, 6, 7, 6, 3, 1]]
  ] as const)("uses spin-1 intensities for %s", async (smiles, label, intensities) => {
    const result = await predict(smiles);
    const methyl = resonanceAt(result, 0);
    expect(methyl.equivalentNuclei).toBe(3);
    expect(methyl.multiplet?.label).toBe(label);
    expect(methyl.multiplet?.couplings).toHaveLength(1);
    expect(methyl.multiplet?.couplings[0]).toMatchObject({
      partnerNucleus: "2H", jHz: 7 * DEUTERIUM_PROTON_GYROMAGNETIC_RATIO
    });
    const lines = firstOrderLines(methyl.multiplet!.couplings);
    expect(relativeIntensities(lines)).toEqual(intensities);
    expect(lines.reduce((sum, line) => sum + line.intensity, 0)).toBeCloseTo(1);
    for (let index = 1; index < lines.length; index += 1) {
      expect(lines[index].offsetHz - lines[index - 1].offsetHz).toBeCloseTo(1.0745);
    }
  });

  it("ethanol-1,1-d2 gives a methyl quintet and no ¹H signal at CD2", async () => {
    const result = await predict("CC([2H])([2H])O");
    const protons = result.resonances.filter((resonance) => resonance.nucleus === "1H");
    expect(protons).toHaveLength(1);
    expect(protons[0]).toMatchObject({ equivalentNuclei: 3, multiplet: { label: "quint" } });
    expect(protons[0].atomRefs.map((ref) => ref.sourceAtomIndex)).toEqual([0]);
  });

  it("nests H–H and H–D splitting for CH3–CHD2 without counting D as ¹H", async () => {
    const result = await predict("CC([2H])([2H])");
    const methyl = resonanceAt(result, 0);
    expect(methyl.multiplet).toMatchObject({ label: "dquint", couplings: [
      { jHz: 7, partnerCount: 1 },
      { jHz: 1.0745, partnerCount: 2, partnerNucleus: "2H" }
    ] });
    const lines = firstOrderLines(methyl.multiplet!.couplings);
    expect(relativeIntensities(lines)).toEqual([1, 2, 3, 2, 1, 1, 2, 3, 2, 1]);
    expect(lines.map((line) => line.offsetHz)).toEqual([
      -5.649, -4.5745, -3.5, -2.4255, -1.351, 1.351, 2.4255, 3.5, 4.5745, 5.649
    ]);
    const chd2 = resonanceAt(result, 1);
    expect(chd2).toMatchObject({ equivalentNuclei: 1, atomRefs: [{ equivalentCount: 1 }], multiplet: { label: "q" } });
    expect(chd2.multiplet?.couplings.some((coupling) => coupling.partnerNucleus === "2H")).toBe(false);
    expect(result.warnings.find((warning) => warning.code === NmrWarningCodes.DeuteriumShiftNotModelled)?.message)
      .toContain("geminal H–D is omitted");
  });

  it("a single remaining proton in CHD2 is observed; a fully deuterated molecule has no ¹H signal", async () => {
    const chd2 = await predict("C([2H])([2H])Cl", ["1H"]);
    expect(chd2.resonances).toHaveLength(1);
    expect(chd2.resonances[0]).toMatchObject({ equivalentNuclei: 1, multiplet: { label: "s", couplings: [] } });
    const cd4 = await predict("C([2H])([2H])([2H])[2H]", ["1H"]);
    expect(cd4.resonances).toEqual([]);
  });

  it("D-only hosts do not enter H–H coupling vectors", () => {
    const molecule = OCL.Molecule.fromSmiles("CC([2H])([2H])[2H]");
    expect(reportedProtonCouplingHz(molecule, 0, 1)).toBe(0);
    expect(reportedProtonCouplingHz(molecule, 1, 0)).toBe(0);
    expect(computeMultiplet(molecule, 1)).toEqual({ label: "s", couplings: [] });
  });

  it("scales the existing aromatic-ortho and aldehyde H–H constants without losing small H–D J", () => {
    const aldehyde = OCL.Molecule.fromSmiles("CC(=O)[2H]");
    expect(computeMultiplet(aldehyde, 0)).toMatchObject({ label: "t", couplings: [
      { kind: "aldehyde", partnerNucleus: "2H", jHz: 2.4 * DEUTERIUM_PROTON_GYROMAGNETIC_RATIO }
    ] });
    const aromatic = OCL.Molecule.fromSmiles("c1c([2H])cccc1");
    const dCoupling = computeMultiplet(aromatic, 0).couplings.find((coupling) => coupling.partnerNucleus === "2H");
    expect(dCoupling).toMatchObject({ kind: "aromatic-ortho", jHz: 7.8 * DEUTERIUM_PROTON_GYROMAGNETIC_RATIO });
  });

  it("does not let equivalent proton hosts suppress their vicinal D partners", async () => {
    const result = await predict("[2H]C([2H])C([2H])[2H]", ["1H"]);
    expect(result.resonances).toHaveLength(1);
    expect(result.resonances[0]).toMatchObject({ equivalentNuclei: 2, multiplet: { label: "quint" } });
  });

  it.each(["CC([2H])([2H])O", "CC([2H])([2H])", "CC([2H])([2H])[2H]"])(
    "molfile D and H + M ISO 2 give identical output for %s", async (smiles) => {
      const d = await predict(molfileFor(smiles, "D"), undefined, "molfile-v2000");
      const iso = await predict(molfileFor(smiles, "ISO"), undefined, "molfile-v2000");
      expect(JSON.stringify(d)).toBe(JSON.stringify(iso));
      expect(JSON.stringify(reportFor(d))).toBe(JSON.stringify(reportFor(iso)));
      expect(renderStickSpectrumSvg(d)).toBe(renderStickSpectrumSvg(iso));
      expect(d.depiction?.atoms.filter((atom) => atom.element === "D")).toHaveLength(
        (smiles.match(/\[2H\]/g) ?? []).length
      );
      expect(resonanceAt(d, 0).multiplet?.couplings.some((coupling) => coupling.partnerNucleus === "2H")).toBe(true);
    }
  );

  it("keeps source assignments when explicit D precedes heavy atoms and ordinary H is also explicit", async () => {
    const result = await predict("[2H]C([2H])([2H])C([H])([H])O");
    const protons = result.resonances.filter((resonance) => resonance.nucleus === "1H");
    expect(protons).toHaveLength(1);
    expect(protons[0]).toMatchObject({ equivalentNuclei: 2, multiplet: { label: "sept" } });
    const molecule = OCL.Molecule.fromSmiles("[2H]C([2H])([2H])C([H])([H])O");
    molecule.ensureHelperArrays(OCL.Molecule.cHelperRings);
    const host = protons[0].atomRefs[0].sourceAtomIndex;
    expect(molecule.getAtomicNo(host)).toBe(6);
    expect(resonanceAt(result, host).deltaPpm).toBe(resonanceAt(await predict("CCO"), 1).deltaPpm);
  });

  it("accepts V3000 mass-2 hydrogen atoms", async () => {
    const molfile = OCL.Molecule.fromSmiles("CC([2H])([2H])O").toMolfileV3();
    const result = await predict(molfile, ["1H"], "molfile-v3000");
    expect(result.resonances).toHaveLength(1);
    expect(result.resonances[0]).toMatchObject({ equivalentNuclei: 3, multiplet: { label: "quint" } });
  });

  it("keeps ¹H/¹³C parent shift values and names deuterated carbons in the isotope-shift warning", async () => {
    const parent = await predict("CCO");
    const deuterated = await predict("CC([2H])([2H])O");
    for (const nucleus of ["1H", "13C"] as const) {
      expect(resonanceAt(deuterated, 0, nucleus).deltaPpm).toBe(resonanceAt(parent, 0, nucleus).deltaPpm);
    }
    expect(resonanceAt(deuterated, 1, "13C").deltaPpm).toBe(resonanceAt(parent, 1, "13C").deltaPpm);
    const carbonOnly = await predict("CC([2H])([2H])O", ["13C"]);
    expect(carbonOnly.warnings.find((warning) => warning.code === NmrWarningCodes.CarbonDeuteriumSplittingNotModelled))
      .toMatchObject({ atomIndices: [1], message: expect.stringContaining("isotope shifts are not modelled") });
  });

  it("preserves D spin metadata through schema validation and renders SDK-valid spin-1 lines", async () => {
    const result = await predict("CC([2H])([2H])O", ["1H"]);
    const roundTripped = NmrPredictionResultSchema.parse(JSON.parse(JSON.stringify(result)));
    expect(roundTripped.resonances[0].multiplet?.couplings[0].partnerNucleus).toBe("2H");
    const report = reportFor(roundTripped);
    expect(PluginPanelReportSchema.safeParse(report).success).toBe(true);
    const figure = report.sections.find((section) => section.kind === "linkedFigure");
    if (!figure || figure.kind !== "linkedFigure") throw new Error("Missing linked figure");
    const peaks = figure.spectrum.peaks;
    expect(peaks).toHaveLength(3); // two symmetric pairs and a central singlet
    expect(peaks.every((peak) => peak.ppm === result.resonances[0].deltaPpm && peak.atomIndices[0] === 0)).toBe(true);
    const lines = hostLines(peaks, 400);
    expect(lines.map((line) => Math.round(line.intensity / lines[0].intensity))).toEqual([1, 2, 3, 2, 1]);
    expect(lines.reduce((sum, line) => sum + line.intensity, 0)).toBeCloseTo(3);
    expect(Math.abs((lines[1].ppm - lines[0].ppm) * 400 - 1.0745)).toBeLessThan(1e-9);
    const text = JSON.stringify(report);
    expect(text).toContain("H–D est.");
    expect(text).toContain("typical first-order estimates");
    expect(text).toContain(String(DEUTERIUM_PROTON_GYROMAGNETIC_RATIO));
    expect(text).toContain("IUPAC Recommendations 2001 magnetogyric ratios (Tables 1 and 2");
    expect(text).toContain("J(HD) = 0.1535 × J(HH)");
    expect(text).toContain("selected spectrometer field");
    expect(text).not.toContain("fixed 400 MHz");
    const svg = renderStickSpectrumSvg(result);
    const sticks = [...svg.matchAll(/<line[^>]*y1="([\d.]+)"[^>]*y2="([\d.]+)"[^>]*stroke="#2563eb"/g)];
    const heights = sticks.map((match) => Number(match[1]) - Number(match[2]));
    expect(heights.map((height) => Math.round(height / heights[0]))).toEqual([1, 2, 3, 2, 1]);
    expect(svg).toContain("typical first-order estimates");
  });

  it("encodes nested H/D splitting as field-adjustable pairs without duplicate splitting", async () => {
    const result = await predict("CC([2H])([2H])", ["1H"]);
    const report = reportFor(result);
    const figure = report.sections.find((section) => section.kind === "linkedFigure");
    if (!figure || figure.kind !== "linkedFigure") throw new Error("Missing linked figure");
    const methylLines = figure.spectrum.peaks.filter((peak) => peak.atomIndices.includes(0));
    expect(methylLines).toHaveLength(5);
    expect(methylLines.every((peak) => peak.couplings?.length === 1 && peak.couplings[0].partnerCount === 1)).toBe(true);
    expect(hostLines(methylLines, 400)).toHaveLength(10);
    expect(figure.spectrum.peaks.find((peak) => peak.atomIndices.includes(1))?.couplings)
      .toEqual([{ jHz: 7, partnerCount: 3 }]);
  });

  it.each([400, 600, 800])("preserves H–D and nested H–H spacing in Hz and every intensity at %i MHz", async (fieldMHz) => {
    for (const smiles of ["CC([2H])(Cl)Cl", "CC([2H])([2H])O", "CC([2H])([2H])[2H]", "CC([2H])([2H])"]) {
      const result = await predict(smiles, ["1H"]);
      const methyl = resonanceAt(result, 0);
      // Exercise comparison shifts and inherited presentation/atom metadata on every component.
      methyl.crossCheck = { incrementPpm: 2.5, disagrees: false };
      const report = reportFor(result);
      expect(PluginPanelReportSchema.safeParse(report).success).toBe(true);
      const peaks = figureFor(result).spectrum.peaks.filter((peak) => peak.atomIndices.includes(0));
      expect(peaks.filter((peak) => peak.label)).toHaveLength(1);
      expect(peaks.every((peak) => peak.alternativePpm === 2.5)).toBe(true);
      const expected = firstOrderLines(methyl.multiplet!.couplings);
      for (const alternative of [false, true]) {
        const center = alternative ? 2.5 : methyl.deltaPpm;
        const lines = hostLines(peaks, fieldMHz, alternative);
        expect(lines).toHaveLength(expected.length);
        lines.forEach((line, index) => {
          expect(Math.abs((line.ppm - center) * fieldMHz - expected[index].offsetHz)).toBeLessThan(1e-9);
          expect(line.intensity).toBe(expected[index].intensity * 3);
        });
        // Adjacent D lines have the physical J(H,D), at every selected field.
        expect(Math.abs((lines[1].ppm - lines[0].ppm) * fieldMHz - 1.0745)).toBeLessThan(1e-9);
        if (expected.length === 10) {
          // The two nested quintets are separated by the original J(H,H).
          expect(Math.abs((lines[5].ppm - lines[0].ppm) * fieldMHz - 7)).toBeLessThan(1e-9);
        }
      }
    }
  });

  it.each([400, 600, 800])("keeps ordinary H–H splitting field-aware at %i MHz", async (fieldMHz) => {
    const result = await predict("CCO", ["1H"]);
    for (const [atom, weights] of [[0, [1, 2, 1]], [1, [1, 3, 3, 1]]] as const) {
      const peaks = figureFor(result).spectrum.peaks.filter((peak) => peak.atomIndices.includes(atom));
      expect(peaks).toHaveLength(1); // H-only groups remain native host couplings.
      const lines = hostLines(peaks, fieldMHz);
      expect(lines.map((line) => Math.round(line.intensity / lines[0].intensity))).toEqual(weights);
      for (let i = 1; i < lines.length; i += 1) {
        expect(Math.abs((lines[i].ppm - lines[i - 1].ppm) * fieldMHz - 7)).toBeLessThan(1e-9);
      }
    }
  });
});

describe("unchanged output for structures without D", () => {
  // SHA-256 of complete serialized results, reports and SVGs captured before this implementation.
  // Any byte change, including property order, atom ordering, shift values or H–H constants fails.
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  it.each(baselines)("preserves all bytes for $structure.value", async (baseline) => {
    const structure = baseline.structure as ChemicalStructureInput;
    const result = await predict(structure.value, undefined, structure.format);
    expect(digest(JSON.stringify(result))).toBe(baseline.resultSha256);
    expect(digest(JSON.stringify(reportFor(result, structure)))).toBe(baseline.reportSha256);
    expect(digest(renderStickSpectrumSvg(result))).toBe(baseline.svgSha256);
  });
});
