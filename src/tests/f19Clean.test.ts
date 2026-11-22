import * as OCL from "openchemlib";
import { describe, expect, it } from "vitest";

import {
  cleanRow,
  DROP_REASONS,
  fluorineType,
  peakShift,
  sourceKey,
  stereoFreeIdcode,
  type CleanedRecord,
  type ExtractedRow
} from "../providers/ocl/f19";
import { prepareProductionLookup, productionClassRepresentative } from "../providers/ocl/productionLookup";

function row(overrides: Partial<ExtractedRow> = {}): ExtractedRow {
  return {
    row: 7,
    filename: "10.1000_example.paper_MOESM1_ESM",
    smiles: "CC(F)(F)F",
    solvent: "CDCl3",
    peaks: [-63.2],
    ...overrides
  };
}

function kept(result: ReturnType<typeof cleanRow>): CleanedRecord {
  if ("drop" in result) throw new Error(`expected a kept row, got ${result.drop}`);
  return result;
}

function typeOf(smiles: string): string {
  const molecule = OCL.Molecule.fromSmiles(smiles);
  for (let atom = 0; atom < molecule.getAllAtoms(); atom += 1) {
    if (molecule.getAtomicNo(atom) === 9) return fluorineType(molecule, atom);
  }
  throw new Error("no fluorine in fixture");
}

describe("sourceKey (§2.6)", () => {
  it("lowercases and trims", () => {
    expect(sourceKey("  10.1021_ACS.ORGLETT.0C01234 \n")).toBe("10.1021_acs.orglett.0c01234");
  });

  it("removes each of the three supplement suffixes", () => {
    expect(sourceKey("10.1186_s13321_MOESM1_ESM")).toBe("10.1186_s13321");
    expect(sourceKey("10.1186_s13321_moesm12_esm")).toBe("10.1186_s13321");
    expect(sourceKey("c9ob01234a_si_001")).toBe("c9ob01234a");
    expect(sourceKey("10.3762_bjoc.12.3-SUP-1-MISC_INFORMATION")).toBe("10.3762_bjoc.12.3");
  });

  it("supplement files of one paper share a key", () => {
    expect(sourceKey("Paper_SI_1")).toBe(sourceKey("paper_si_2"));
    expect(sourceKey("paper_MOESM1_ESM")).toBe(sourceKey("paper"));
  });

  it("strips only one trailing suffix and nothing mid-string", () => {
    expect(sourceKey("paper_si_1_si_2")).toBe("paper_si_1");
    expect(sourceKey("paper_moesm1_esm_moesm2_esm")).toBe("paper_moesm1_esm");
    expect(sourceKey("paper-sup-1-misc_information-sup-2-misc_information")).toBe("paper-sup-1-misc_information");
    expect(sourceKey("paper_si_1.pdf")).toBe("paper_si_1.pdf");
    expect(sourceKey("paper_si_")).toBe("paper_si_");
    expect(sourceKey("paper_moesm_esm")).toBe("paper_moesm_esm");
  });

  it("trims before the suffix check", () => {
    expect(sourceKey("paper_si_3  ")).toBe("paper");
  });
});

describe("peakShift (§2.4)", () => {
  it("takes a single number", () => {
    expect(peakShift([-63.2])).toEqual({ shift: -63.2 });
  });

  it("reads a range as its midpoint, keeping |a − b| exactly 1 and dropping 1.01", () => {
    expect(peakShift([[-120, -121]])).toEqual({ shift: -120.5 });
    expect(peakShift([[-121.5, -120.5]])).toEqual({ shift: -121 });
    expect(peakShift([[-120, -121.01]])).toEqual({ drop: "peak-range-too-wide" });
  });

  it("keeps a spread of exactly 0.05 and drops 0.051", () => {
    const keptSpread = peakShift([-120.0, -120.05]);
    expect("shift" in keptSpread && keptSpread.shift).toBeCloseTo(-120.025, 10);
    expect(peakShift([-63.1, -63.15])).toHaveProperty("shift");
    expect(peakShift([-120.0, -120.051])).toEqual({ drop: "peak-spread" });
  });

  it("keeps decimal differences of exactly 1 and 0.05 even when binary floats overshoot", () => {
    expect(peakShift([120.05, 120.0])).toHaveProperty("shift");
    expect(peakShift([[-62.35, -61.35]])).toHaveProperty("shift");
    // These pairs differ by exactly 0.05 or 1 in decimal but by slightly more in binary floats.
    expect(-120.1 - -120.15).toBeGreaterThan(0.05);
    expect(peakShift([-120.15, -120.1])).toHaveProperty("shift");
    expect(-63.98 - -64.98).toBeGreaterThan(1);
    const range = peakShift([[-64.98, -63.98]]);
    expect("shift" in range && range.shift).toBeCloseTo(-64.48, 10);
    expect(peakShift([[-64.98, -63.97]])).toEqual({ drop: "peak-range-too-wide" });
    expect(peakShift([-120.15, -120.099])).toEqual({ drop: "peak-spread" });
  });

  it("uses max − min, so a chain of close values 0.00/0.04/0.08 drops", () => {
    expect(peakShift([-100.0, -100.04, -100.08])).toEqual({ drop: "peak-spread" });
  });

  it("takes the median of the values, ranges included", () => {
    expect(peakShift([-80.0, -80.04, -80.01])).toEqual({ shift: -80.01 });
    const even = peakShift([-80.0, -80.04, [-80.02, -80.0], -80.03]);
    expect("shift" in even && even.shift).toBeCloseTo(-80.02, 10);
  });

  it("applies the spread rule to range midpoints", () => {
    expect(peakShift([[-120, -121], -120.5])).toEqual({ shift: -120.5 });
    expect(peakShift([[-120, -121], -120.4])).toEqual({ drop: "peak-spread" });
  });

  it("drops an empty list and every other shape", () => {
    expect(peakShift([])).toEqual({ drop: "no-peak-values" });
    expect(peakShift(["-63.2"])).toEqual({ drop: "peak-shape" });
    expect(peakShift([null])).toEqual({ drop: "peak-shape" });
    expect(peakShift([true])).toEqual({ drop: "peak-shape" });
    expect(peakShift([[-63.2]])).toEqual({ drop: "peak-shape" });
    expect(peakShift([[-63.2, -63.3, -63.4]])).toEqual({ drop: "peak-shape" });
    expect(peakShift([[-63.2, "x"]])).toEqual({ drop: "peak-shape" });
    expect(peakShift([-63.2, { a: 1 }])).toEqual({ drop: "peak-shape" });
    expect(peakShift([Number.NaN])).toEqual({ drop: "peak-shape" });
  });
});

describe("fluorineType (§6)", () => {
  it("assigns each type", () => {
    expect(typeOf("FS(F)(F)(F)(F)F")).toBe("hetero-F");
    expect(typeOf("CC(F)(F)F")).toBe("CF3");
    expect(typeOf("C(F)F")).toBe("CF2");
    expect(typeOf("Fc1ccccc1")).toBe("aryl-F");
    expect(typeOf("O=C(F)C")).toBe("acyl-F");
    expect(typeOf("FC=C")).toBe("vinyl-F");
    expect(typeOf("CCF")).toBe("alkyl-F");
    expect(typeOf("FC#C")).toBe("other");
  });

  it("applies the rules in first-match order", () => {
    // hetero-F wins regardless of what else is present.
    expect(typeOf("FB(F)F")).toBe("hetero-F");
    expect(typeOf("F")).toBe("hetero-F");
    // CF3/CF2 require an sp³ carbon: F₂C=CH₂ is vinyl-F, F₂C=O is acyl-F.
    expect(typeOf("FC(F)=C")).toBe("vinyl-F");
    expect(typeOf("O=C(F)F")).toBe("acyl-F");
    // acyl-F before vinyl-F: both hosts are non-aromatic sp² carbons.
    expect(typeOf("O=C(F)C=C")).toBe("acyl-F");
    // An aromatic carbon is aryl-F, not vinyl-F.
    expect(typeOf("Fc1ccncc1")).toBe("aryl-F");
    // Exact counts: CF4 is none of CF3/CF2/alkyl-F.
    expect(typeOf("FC(F)(F)F")).toBe("other");
  });
});

describe("productionClassRepresentative (§2.3)", () => {
  it("gives atoms of one class one representative and throws on an unknown atom", () => {
    const molecule = OCL.Molecule.fromSmiles("FC(F)(F)CCF");
    const context = prepareProductionLookup(molecule);
    const fluorines: number[] = [];
    for (let atom = 0; atom < molecule.getAllAtoms(); atom += 1) {
      if (molecule.getAtomicNo(atom) === 9) fluorines.push(atom);
    }
    expect(new Set(fluorines.map((atom) => productionClassRepresentative(context, atom))).size).toBe(2);
    expect(() => productionClassRepresentative(context, molecule.getAllAtoms())).toThrow();
    expect(() => productionClassRepresentative(context, -1)).toThrow();
    expect(() => productionClassRepresentative(context, 0.5)).toThrow();
  });
});

describe("cleanRow (§2.2–2.7)", () => {
  it("keeps a clean row with source key, stereo-free idcode, shift and type", () => {
    const record = kept(cleanRow(row()));
    expect(record).toEqual({
      row: 7,
      sourceKey: "10.1000_example.paper",
      idcode: stereoFreeIdcode(OCL.Molecule.fromSmiles("CC(F)(F)F")),
      shift: -63.2,
      solvent: "CDCl3",
      fluorineAtoms: 3,
      fluorineType: "CF3"
    });
  });

  it("gives stereoisomers one idcode", () => {
    const e = kept(cleanRow(row({ smiles: "F/C=C/C" })));
    const z = kept(cleanRow(row({ smiles: "F/C=C\\C" })));
    expect(e.idcode).toBe(z.idcode);
    expect(e.fluorineType).toBe("vinyl-F");
  });

  it("keeps a molecule with symmetric fluorines in one class", () => {
    const record = kept(cleanRow(row({ smiles: "Fc1ccc(F)cc1", peaks: [-119.5] })));
    expect(record.fluorineAtoms).toBe(2);
    expect(record.fluorineType).toBe("aryl-F");
  });

  it("allows non-fluorine fragments (salts)", () => {
    expect(kept(cleanRow(row({ smiles: "CC(F)(F)F.[Na+].[Cl-]" }))).fluorineType).toBe("CF3");
  });

  it("drops with every reason, in protocol order", () => {
    const cases: [Partial<ExtractedRow>, string][] = [
      [{ smiles: "C1CC(" }, "smiles-unparseable"],
      [{ smiles: "" }, "smiles-unparseable"],
      [{ smiles: null }, "smiles-unparseable"],
      [{ smiles: "CCO" }, "no-fluorine"],
      [{ smiles: "CF.CF" }, "fluorine-in-multiple-fragments"],
      [{ smiles: "FCCC(F)(F)F" }, "multiple-fluorine-environments"],
      [{ peaks: null }, "peaks-unparseable"],
      [{ peaks: [] }, "no-peak-values"],
      [{ peaks: ["x"] }, "peak-shape"],
      [{ peaks: [[-60, -62]] }, "peak-range-too-wide"],
      [{ peaks: [-63.2, -63.3] }, "peak-spread"],
      [{ peaks: [-300.01] }, "shift-out-of-range"],
      [{ peaks: [250.01] }, "shift-out-of-range"]
    ];
    for (const [overrides, reason] of cases) {
      expect(cleanRow(row(overrides))).toEqual({ drop: reason });
    }
    // symmetry-classes-failed and idcode-failed only guard OpenChemLib exceptions that no valid
    // SMILES is known to trigger; every other reason is reached above.
    const reached = new Set(cases.map(([, reason]) => reason));
    expect(DROP_REASONS.filter((reason) => !reached.has(reason))).toEqual(["symmetry-classes-failed", "idcode-failed"]);
  });

  it("applies the structure rules before the peak rules", () => {
    expect(cleanRow(row({ smiles: "CCO", peaks: null }))).toEqual({ drop: "no-fluorine" });
    expect(cleanRow(row({ smiles: "FCCC(F)(F)F", peaks: [-400] }))).toEqual({ drop: "multiple-fluorine-environments" });
  });

  it("keeps the range ends −300 and +250", () => {
    expect(kept(cleanRow(row({ peaks: [-300] }))).shift).toBe(-300);
    expect(kept(cleanRow(row({ peaks: [250] }))).shift).toBe(250);
  });

  it("never drops on the file name", () => {
    expect(kept(cleanRow(row({ filename: "" }))).sourceKey).toBe("");
  });
});
