import * as OCL from "openchemlib";
import { describe, expect, it } from "vitest";

import {
  cleanRow,
  DROP_REASONS,
  fluorineType,
  peakShift,
  sourceKey,
  stereoFreeIdcode,
  stereoIdcode,
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
    peaks: ["-63.2"],
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
    expect(peakShift(["-63.2"])).toEqual({ shift: -63.2 });
  });

  it("reads a range as its midpoint, keeping |a − b| exactly 1 and dropping 1.01", () => {
    expect(peakShift([["-120", "-121"]])).toEqual({ shift: -120.5 });
    expect(peakShift([["-121.5", "-120.5"]])).toEqual({ shift: -121 });
    expect(peakShift([["-120", "-121.01"]])).toEqual({ drop: "peak-range-too-wide" });
  });

  it("keeps a spread of exactly 0.05 and drops 0.051", () => {
    const keptSpread = peakShift(["-120.0", "-120.05"]);
    expect("shift" in keptSpread && keptSpread.shift).toBeCloseTo(-120.025, 10);
    expect(peakShift(["-63.1", "-63.15"])).toHaveProperty("shift");
    expect(peakShift(["-120.0", "-120.051"])).toEqual({ drop: "peak-spread" });
  });

  it("keeps decimal differences of exactly 1 and 0.05 even when binary floats overshoot", () => {
    expect(peakShift(["120.05", "120.0"])).toHaveProperty("shift");
    expect(peakShift([["-62.35", "-61.35"]])).toHaveProperty("shift");
    // These pairs differ by exactly 0.05 or 1 in decimal but by slightly more in binary floats.
    expect(-120.1 - -120.15).toBeGreaterThan(0.05);
    expect(peakShift(["-120.15", "-120.1"])).toHaveProperty("shift");
    expect(-63.98 - -64.98).toBeGreaterThan(1);
    const range = peakShift([["-64.98", "-63.98"]]);
    expect("shift" in range && range.shift).toBeCloseTo(-64.48, 10);
    expect(peakShift([["-64.98", "-63.97"]])).toEqual({ drop: "peak-range-too-wide" });
    expect(peakShift(["-120.15", "-120.099"])).toEqual({ drop: "peak-spread" });
  });

  it("uses max − min, so a chain of close values 0.00/0.04/0.08 drops", () => {
    expect(peakShift(["-100.0", "-100.04", "-100.08"])).toEqual({ drop: "peak-spread" });
  });

  it("takes the median of the values, ranges included", () => {
    expect(peakShift(["-80.0", "-80.04", "-80.01"])).toEqual({ shift: -80.01 });
    const even = peakShift(["-80.0", "-80.04", ["-80.02", "-80.0"], "-80.03"]);
    expect("shift" in even && even.shift).toBeCloseTo(-80.02, 10);
  });

  it("applies the spread rule to range midpoints", () => {
    expect(peakShift([["-120", "-121"], "-120.5"])).toEqual({ shift: -120.5 });
    expect(peakShift([["-120", "-121"], "-120.4"])).toEqual({ drop: "peak-spread" });
  });

  it("drops values just above the spread limit 0.05 and keeps exactly 0.05", () => {
    expect(peakShift(["0", "0.05"])).toHaveProperty("shift");
    expect(peakShift(["0", "0.0500004"])).toEqual({ drop: "peak-spread" });
    expect(peakShift(["0", "0.050000000001"])).toEqual({ drop: "peak-spread" });
    expect(peakShift(["-120.05", "-119.9999999999999"])).toEqual({ drop: "peak-spread" });
    expect(peakShift(["120.05", "120.00"])).toHaveProperty("shift");
    expect(peakShift(["120.05", "120.0", "120.02"])).toEqual({ shift: 120.02 });
    expect(peakShift(["5e-2", "0"])).toHaveProperty("shift");
    expect(peakShift(["5.00000001e-2", "0"])).toEqual({ drop: "peak-spread" });
  });

  it("drops ranges just above the width limit 1 and keeps exactly 1", () => {
    expect(peakShift([["0", "1"]])).toEqual({ shift: 0.5 });
    expect(peakShift([["0", "1.0000004"]])).toEqual({ drop: "peak-range-too-wide" });
    expect(peakShift([["1.0000004", "0"]])).toEqual({ drop: "peak-range-too-wide" });
    expect(peakShift([["0", "1.000000000001"]])).toEqual({ drop: "peak-range-too-wide" });
    expect(peakShift([["-64.98", "-63.98"]])).toHaveProperty("shift");
    expect(peakShift([["-63.98", "-64.98"]])).toHaveProperty("shift");
    expect(peakShift([["-64.98", "-63.9799999"]])).toEqual({ drop: "peak-range-too-wide" });
    expect(peakShift([["1e-05", "-0.99999"]])).toHaveProperty("shift");
    expect(peakShift([["1.1e-05", "-0.99999"]])).toEqual({ drop: "peak-range-too-wide" });
  });

  it("compares range midpoints exactly for the spread rule", () => {
    // Midpoints -120.5 and -120.45: spread exactly 0.05, kept; -120.4499999 is just above.
    expect(peakShift([["-120", "-121"], "-120.45"])).toHaveProperty("shift");
    expect(peakShift([["-120", "-121"], "-120.4499999"])).toEqual({ drop: "peak-spread" });
    // Midpoints -0.025 and 0.025 from ranges of odd last digits.
    expect(peakShift([["-0.03", "-0.02"], ["0.02", "0.03"]])).toHaveProperty("shift");
    expect(peakShift([["-0.03", "-0.02"], ["0.02", "0.0300001"]])).toEqual({ drop: "peak-spread" });
  });

  it("reads Python repr forms: integers, exponents and negative zero", () => {
    expect(peakShift(["-63"])).toEqual({ shift: -63 });
    expect(peakShift(["1e-05"])).toEqual({ shift: 1e-5 });
    expect(peakShift(["-0.0", "0.05"])).toHaveProperty("shift");
    expect(peakShift(["-0.0", "0.0500004"])).toEqual({ drop: "peak-spread" });
    expect(peakShift(["1e+2", "100.05"])).toHaveProperty("shift");
    expect(peakShift(["-95.47"])).toEqual({ shift: -95.47 });
  });

  it("drops malformed decimal strings as peak shape", () => {
    for (const bad of [
      "",
      " -63.2",
      "-63.2 ",
      "+63.2",
      "x",
      ".5",
      "5.",
      "-",
      "1e",
      "1e+",
      "0x10",
      "1_000",
      "inf",
      "-inf",
      "nan",
      "Infinity",
      "NaN",
      "1e400",
      "1e-999",
      "0e99999999999999999999",
      "--1"
    ]) {
      expect(peakShift([bad]), bad).toEqual({ drop: "peak-shape" });
      expect(peakShift([["-63.2", bad]]), bad).toEqual({ drop: "peak-shape" });
    }
  });

  it("drops an empty list and every other shape", () => {
    expect(peakShift([])).toEqual({ drop: "no-peak-values" });
    // The extractor hands over decimal strings; a bare number is not a shape it writes.
    expect(peakShift([-63.2])).toEqual({ drop: "peak-shape" });
    expect(peakShift([[-120, -121]])).toEqual({ drop: "peak-shape" });
    expect(peakShift([null])).toEqual({ drop: "peak-shape" });
    expect(peakShift([true])).toEqual({ drop: "peak-shape" });
    expect(peakShift([["-63.2"]])).toEqual({ drop: "peak-shape" });
    expect(peakShift([["-63.2", "-63.3", "-63.4"]])).toEqual({ drop: "peak-shape" });
    expect(peakShift([["-63.2", "x"]])).toEqual({ drop: "peak-shape" });
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
  it("keeps a clean row with source key, both idcodes, shift and type", () => {
    const record = kept(cleanRow(row()));
    expect(record).toEqual({
      row: 7,
      sourceKey: "10.1000_example.paper",
      stereoFreeIdcode: stereoFreeIdcode(OCL.Molecule.fromSmiles("CC(F)(F)F")),
      stereoIdcode: stereoIdcode(OCL.Molecule.fromSmiles("CC(F)(F)F")),
      shift: -63.2,
      solvent: "CDCl3",
      fluorineAtoms: 3,
      fluorineType: "CF3",
      removedFragments: 0
    });
  });

  it("gives E/Z isomers one stereo-free idcode and different stereo idcodes", () => {
    const e = kept(cleanRow(row({ smiles: "F/C=C/C" })));
    const z = kept(cleanRow(row({ smiles: "F/C=C\\C" })));
    expect(e.stereoFreeIdcode).toBe(z.stereoFreeIdcode);
    expect(e.stereoIdcode).not.toBe(z.stereoIdcode);
    expect(e.fluorineType).toBe("vinyl-F");
  });

  it("gives R/S enantiomers one stereo-free idcode and different stereo idcodes", () => {
    const r = kept(cleanRow(row({ smiles: "C[C@H](F)CC", peaks: ["-172.1"] })));
    const s = kept(cleanRow(row({ smiles: "C[C@@H](F)CC", peaks: ["-172.1"] })));
    const unspecified = kept(cleanRow(row({ smiles: "CC(F)CC", peaks: ["-172.1"] })));
    expect(r.stereoFreeIdcode).toBe(s.stereoFreeIdcode);
    expect(r.stereoFreeIdcode).toBe(unspecified.stereoFreeIdcode);
    expect(r.stereoIdcode).not.toBe(s.stereoIdcode);
    expect(new Set([r.stereoIdcode, s.stereoIdcode, unspecified.stereoIdcode]).size).toBe(3);
  });

  it("records OpenChemLib's default idcode as the stereo idcode", () => {
    const record = kept(cleanRow(row()));
    expect(record.stereoIdcode).toBe(OCL.Molecule.fromSmiles("CC(F)(F)F").getIDCode());
  });

  it("keeps a molecule with symmetric fluorines in one class", () => {
    const record = kept(cleanRow(row({ smiles: "Fc1ccc(F)cc1", peaks: ["-119.5"] })));
    expect(record.fluorineAtoms).toBe(2);
    expect(record.fluorineType).toBe("aryl-F");
  });

  it("allows non-fluorine fragments (salts)", () => {
    expect(kept(cleanRow(row({ smiles: "CC(F)(F)F.[Na+].[Cl-]" }))).fluorineType).toBe("CF3");
  });

  describe("fluorine-bearing fragment only (§2.2)", () => {
    function identity(smiles: string): Omit<CleanedRecord, "removedFragments"> {
      const { removedFragments: _removed, ...rest } = kept(cleanRow(row({ smiles })));
      return rest;
    }

    it("gives a fluorinated ammonium chloride the identity of the cation alone", () => {
      const salt = kept(cleanRow(row({ smiles: "C[NH+](C)CC(F)(F)F.[Cl-]" })));
      expect(salt.removedFragments).toBe(1);
      expect(identity("C[NH+](C)CC(F)(F)F.[Cl-]")).toEqual(identity("C[NH+](C)CC(F)(F)F"));
      expect(salt.stereoFreeIdcode).toBe(stereoFreeIdcode(OCL.Molecule.fromSmiles("C[NH+](C)CC(F)(F)F")));
    });

    it("gives sodium trifluoroacetate the identity of trifluoroacetate", () => {
      const salt = kept(cleanRow(row({ smiles: "[Na+].[O-]C(=O)C(F)(F)F" })));
      expect(salt.removedFragments).toBe(1);
      expect(identity("[Na+].[O-]C(=O)C(F)(F)F")).toEqual(identity("[O-]C(=O)C(F)(F)F"));
      expect(salt.stereoIdcode).toBe(stereoIdcode(OCL.Molecule.fromSmiles("[O-]C(=O)C(F)(F)F")));
    });

    it("removes solvent and explicit-hydrogen fragments, keeping the fragment's stereo", () => {
      const solvate = kept(cleanRow(row({ smiles: "C[C@H](F)CC.O.[H]Cl", peaks: ["-172.1"] })));
      const alone = kept(cleanRow(row({ smiles: "C[C@H](F)CC", peaks: ["-172.1"] })));
      expect(solvate.removedFragments).toBe(2);
      expect(solvate.stereoIdcode).toBe(alone.stereoIdcode);
      expect(solvate.stereoFreeIdcode).toBe(alone.stereoFreeIdcode);
      const ez = kept(cleanRow(row({ smiles: "CO.F/C=C\\C" })));
      expect(ez.stereoIdcode).toBe(kept(cleanRow(row({ smiles: "F/C=C\\C" }))).stereoIdcode);
    });

    it("judges symmetry and type on the fragment, not the salt", () => {
      // A fluoride counterion would make a second fluorine fragment and drop; a chloride does not
      // add fluorines, and the fragment keeps its own class and type.
      const record = kept(cleanRow(row({ smiles: "Fc1ccc(cc1)[N+](C)(C)C.[Br-]", peaks: ["-112.0"] })));
      expect(record.fluorineAtoms).toBe(1);
      expect(record.fluorineType).toBe("aryl-F");
      expect(cleanRow(row({ smiles: "C[N+](C)(C)C.[F-].CF" }))).toEqual({ drop: "fluorine-in-multiple-fragments" });
      expect(kept(cleanRow(row({ smiles: "C[N+](C)(C)C.[F-]", peaks: ["-120.0"] }))).fluorineType).toBe("other");
    });
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
      [{ peaks: [["-60", "-62"]] }, "peak-range-too-wide"],
      [{ peaks: ["-63.2", "-63.3"] }, "peak-spread"],
      [{ peaks: ["-300.01"] }, "shift-out-of-range"],
      [{ peaks: ["250.01"] }, "shift-out-of-range"]
    ];
    for (const [overrides, reason] of cases) {
      expect(cleanRow(row(overrides))).toEqual({ drop: reason });
    }
    // fragment-extraction-failed, symmetry-classes-failed and idcode-failed only guard OpenChemLib exceptions that no valid
    // SMILES is known to trigger; every other reason is reached above.
    const reached = new Set(cases.map(([, reason]) => reason));
    expect(DROP_REASONS.filter((reason) => !reached.has(reason))).toEqual([
      "fragment-extraction-failed",
      "symmetry-classes-failed",
      "idcode-failed"
    ]);
  });

  it("applies the structure rules before the peak rules", () => {
    expect(cleanRow(row({ smiles: "CCO", peaks: null }))).toEqual({ drop: "no-fluorine" });
    expect(cleanRow(row({ smiles: "FCCC(F)(F)F", peaks: ["-400"] }))).toEqual({ drop: "multiple-fluorine-environments" });
  });

  it("keeps the range ends −300 and +250", () => {
    expect(kept(cleanRow(row({ peaks: ["-300"] }))).shift).toBe(-300);
    expect(kept(cleanRow(row({ peaks: ["250"] }))).shift).toBe(250);
  });

  it("never drops on the file name", () => {
    expect(kept(cleanRow(row({ filename: "" }))).sourceKey).toBe("");
  });
});
