import * as OCL from "openchemlib";
import { describe, expect, it } from "vitest";

import type { NmrNucleus, NmrPredictionOptions } from "../domain/contracts";
import { NmrPredictionResultSchema } from "../domain/schemas";
import { buildNmrDatabase } from "../providers/ocl/buildDatabase";
import { atomEnvironmentCodes, environmentKey } from "../providers/ocl/environmentCode";
import type { CompiledNmrDatabase, NmrDatabaseEntry } from "../providers/ocl/localDatabase";
import { OclHosePredictor } from "../providers/ocl/OclHosePredictor";

const OPTIONS: NmrPredictionOptions = {
  statistic: "median",
  hoseLevels: [4, 3, 2, 1],
  ignoreLabileHydrogens: true
};

const PROVENANCE = {
  name: "test",
  version: "1",
  source: "s",
  license: "l",
  attribution: "a",
  note: "n",
  structureCount: 1,
  entryCount: 0,
  nuclei: ["1H", "13C"] as const,
  generatedAt: "t"
};

function makeSd(smiles: string, carbons: { atom: number; shift: number }[]): string {
  const molfile = OCL.Molecule.fromSmiles(smiles).toMolfile();
  const assignment = carbons.map((carbon, index) => `s${index}, ${carbon.shift}, ${carbon.atom}\\`).join("\n");
  const spectrum = carbons.map((carbon, index) => `${carbon.shift}, L=s${index}\\`).join("\n");
  return `${molfile}\n> <NMREDATA_ASSIGNMENT>\n${assignment}\n\n> <NMREDATA_1D_13C>\n${spectrum}\n\n$$$$\n`;
}

function database(entries: Record<string, NmrDatabaseEntry> = {}): CompiledNmrDatabase {
  return { provenance: { ...PROVENANCE, entryCount: Object.keys(entries).length }, entries };
}

function shallowDatabase(
  smiles: string,
  nucleus: NmrNucleus,
  stats: Partial<Omit<NmrDatabaseEntry, "nucleus" | "sphere">> = {}
): CompiledNmrDatabase {
  return databaseAtSphere(smiles, nucleus, 1, stats);
}

function databaseAtSphere(
  smiles: string,
  nucleus: NmrNucleus,
  sphere: number,
  stats: Partial<Omit<NmrDatabaseEntry, "nucleus" | "sphere">> = {}
): CompiledNmrDatabase {
  const molecule = OCL.Molecule.fromSmiles(smiles);
  molecule.ensureHelperArrays(OCL.Molecule.cHelperRings);
  const entries: Record<string, NmrDatabaseEntry> = {};
  for (let atom = 0; atom < molecule.getAllAtoms(); atom += 1) {
    const target = nucleus === "13C" ? molecule.getAtomicNo(atom) === 6 : molecule.getAllHydrogens(atom) > 0;
    if (!target) continue;
    const code = atomEnvironmentCodes(molecule, atom, sphere)[0];
    entries[environmentKey(nucleus, code)] = {
      nucleus,
      sphere,
      n: stats.n ?? 10,
      median: stats.median ?? 8,
      mean: stats.mean ?? 8.5,
      stdev: stats.stdev ?? 0.1,
      min: stats.min ?? 7.8,
      max: stats.max ?? 8.8
    };
  }
  return database(entries);
}

function predict(
  predictor: OclHosePredictor,
  smiles: string,
  nucleus: NmrNucleus = "13C",
  statistic: NmrPredictionOptions["statistic"] = "median"
) {
  return predictor.predict({
    structure: { format: "smiles", value: smiles },
    nuclei: [nucleus],
    options: { ...OPTIONS, statistic }
  });
}

function predictMolfile(predictor: OclHosePredictor, smiles: string, nucleus: NmrNucleus) {
  return predictor.predict({
    structure: { format: "molfile-v2000", value: OCL.Molecule.fromSmiles(smiles).toMolfile() },
    nuclei: [nucleus],
    options: OPTIONS
  });
}

function predictExplicitHydrogenMolfile(
  predictor: OclHosePredictor,
  smiles: string,
  nuclei: readonly NmrNucleus[]
) {
  const molecule = OCL.Molecule.fromSmiles(smiles);
  molecule.addImplicitHydrogens();
  return predictor.predict({
    structure: { format: "molfile-v2000", value: molecule.toMolfile() },
    nuclei,
    options: OPTIONS
  });
}

function resonanceClasses(result: Awaited<ReturnType<typeof predictMolfile>>): Map<string, number> {
  return new Map(
    result.resonances.map((resonance) => [
      resonance.atomRefs
        .map((ref) => ref.sourceAtomIndex)
        .sort((a, b) => a - b)
        .join(","),
      resonance.equivalentNuclei ?? 0
    ])
  );
}

describe("OclHosePredictor", () => {
  // Atom sets below are hard-coded from the molfile order and the molecular constitution; they do
  // not call the OCL symmetry API used by the implementation.
  it.each([
    ["toluene", "Cc1ccccc1", "13C", [[[0], 1], [[1], 1], [[2, 6], 2], [[3, 5], 2], [[4], 1]]],
    ["toluene", "Cc1ccccc1", "1H", [[[0], 3], [[2, 6], 2], [[3, 5], 2], [[4], 1]]],
    ["p-xylene", "Cc1ccc(C)cc1", "13C", [[[0, 5], 2], [[1, 4], 2], [[2, 3, 6, 7], 4]]],
    ["p-xylene", "Cc1ccc(C)cc1", "1H", [[[0, 5], 6], [[2, 3, 6, 7], 4]]],
    ["ethanol", "CCO", "13C", [[[0], 1], [[1], 1]]],
    ["ethanol", "CCO", "1H", [[[0], 3], [[1], 2]]],
    ["(R,R)-2,3-dibromobutane", "C[C@H](Br)[C@H](Br)C", "13C", [[[0, 5], 2], [[1, 3], 2]]],
    ["(R,R)-2,3-dibromobutane", "C[C@H](Br)[C@H](Br)C", "1H", [[[0, 5], 6], [[1, 3], 2]]],
    ["meso-2,3-dibromobutane", "C[C@H](Br)[C@@H](Br)C", "13C", [[[0, 5], 2], [[1, 3], 2]]],
    ["meso-2,3-dibromobutane", "C[C@H](Br)[C@@H](Br)C", "1H", [[[0, 5], 6], [[1, 3], 2]]],
    ["(2R,3R)-tartaric acid", "O=C(O)[C@H](O)[C@H](O)C(=O)O", "13C", [[[1, 7], 2], [[3, 5], 2]]],
    ["trans-1,2-dimethylcyclopropane", "C[C@H]1C[C@H]1C", "13C", [[[0, 4], 2], [[1, 3], 2], [[2], 1]]],
    ["naphthalene", "c1ccc2ccccc2c1", "13C", [[[0, 1, 5, 6], 4], [[2, 4, 7, 9], 4], [[3, 8], 2]]]
  ] as const)(
    "groups %s %s molfile atoms into hard-coded constitutional classes",
    async (_name, smiles, nucleus, expectedClasses) => {
      const result = await predictMolfile(new OclHosePredictor({ now: () => "t" }), smiles, nucleus);
      const expected = new Map(
        expectedClasses.map(([atoms, nEquivalent]) => [atoms.join(","), nEquivalent])
      );

      expect(result.resonances).toHaveLength(expectedClasses.length);
      expect(resonanceClasses(result)).toEqual(expected);
      expect(result.resonances.map((resonance) => resonance.equivalentNuclei).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(
        [...expectedClasses].map(([, nEquivalent]) => nEquivalent).sort((a, b) => a - b)
      );
      if (smiles === "CCO" && nucleus === "1H") {
        expect(result.warnings.map((warning) => warning.code)).toContain("NMR_LABILE_PROTON_OMITTED");
      }
    }
  );

  it("gives naphthalene the same shifts and integrations for different input atom orders", async () => {
    const predictor = new OclHosePredictor({ now: () => "t" });
    const first = await predictMolfile(predictor, "c1ccc2ccccc2c1", "13C");
    const second = await predictMolfile(predictor, "c1cc2ccccc2cc1", "13C");
    const sortedShifts = (result: typeof first) =>
      result.resonances
        .map((resonance) => [resonance.deltaPpm, resonance.equivalentNuclei] as const)
        .sort(([firstPpm], [secondPpm]) => firstPpm - secondPpm);

    expect(sortedShifts(first)).toEqual(sortedShifts(second));
  });

  it.each(["13C", "1H"] as const)(
    "returns %s shifts for an explicit-hydrogen CCO.O mixture without aborting disclosure analysis",
    async (nucleus) => {
      const result = await predictExplicitHydrogenMolfile(
        new OclHosePredictor({ now: () => "t" }),
        "CCO.O",
        [nucleus]
      );

      expect(result.resonances.some((resonance) => resonance.nucleus === nucleus)).toBe(true);
      expect(result.warnings.map((warning) => warning.code)).not.toContain(
        "NMR_DISCLOSURE_ANALYSIS_UNAVAILABLE"
      );
    }
  );

  it.each([
    ["single component", "CCO"],
    ["stereocentre", "C[C@H](F)CO"]
  ])("handles an explicit-hydrogen %s molecule", async (_name, smiles) => {
    const result = await predictExplicitHydrogenMolfile(
      new OclHosePredictor({ now: () => "t" }),
      smiles,
      ["13C", "1H"]
    );

    expect(result.resonances.some((resonance) => resonance.nucleus === "13C")).toBe(true);
    expect(result.resonances.some((resonance) => resonance.nucleus === "1H")).toBe(true);
    expect(result.warnings.map((warning) => warning.code)).not.toContain(
      "NMR_DISCLOSURE_ANALYSIS_UNAVAILABLE"
    );
    if (smiles.includes("@")) {
      expect(result.warnings.map((warning) => warning.code)).toContain(
        "NMR_POTENTIALLY_DIASTEREOTOPIC_HYDROGENS"
      );
    }
  });

  it("documents OCL diastereotopic IDs used by the stereo-merge disclosure", () => {
    const ids = (smiles: string) => OCL.Molecule.fromSmiles(smiles).getDiastereotopicAtomIDs();

    const rr = ids("C[C@H](Br)[C@H](Br)C");
    expect(rr[0]).toBe(rr[5]);
    expect(rr[1]).toBe(rr[3]);

    const meso = ids("C[C@H](Br)[C@@H](Br)C");
    expect(meso[0]).toBe(meso[5]);
    expect(meso[1]).toBe(meso[3]);

    const glycerol = ids("OCC(O)CO");
    expect(glycerol[1]).toBe(glycerol[4]);

    const prenol = ids("CC(C)=CCO");
    expect(prenol[0]).not.toBe(prenol[2]);

    const ezMixture = ids("C/C=C/C.C/C=C\\C");
    expect(ezMixture[0]).not.toBe(ezMixture[4]);
    expect(ezMixture[1]).not.toBe(ezMixture[5]);

    const methylButanol = ids("CC(O)C(C)C");
    expect(methylButanol[4]).not.toBe(methylButanol[5]);

    const disconnectedMixture = OCL.Molecule.fromSmiles("CC(C)O.C[C@H](F)Cl").getFragments();
    const isopropanol = disconnectedMixture.find(
      (fragment) => fragment.getAllAtoms() === 4 && fragment.getAtomicNo(3) === 8
    );
    expect(isopropanol).toBeDefined();
    const isopropanolIds = isopropanol!.getDiastereotopicAtomIDs();
    expect(isopropanolIds[0]).toBe(isopropanolIds[2]);
  });

  it("round-trips a built database: querying the training molecule returns its shifts", async () => {
    const compiled = buildNmrDatabase(
      makeSd("CCC", [
        { atom: 1, shift: 15.5 },
        { atom: 2, shift: 16.1 },
        { atom: 3, shift: 15.5 }
      ]),
      { provenance: { name: "test", version: "1", source: "s", license: "l", attribution: "a", note: "n" }, now: () => "t" }
    );
    const predictor = new OclHosePredictor({ database: compiled, now: () => "t" });
    const result = await predict(predictor, "CCC");

    expect(result.resonances.map((resonance) => resonance.deltaPpm).sort((a, b) => a - b)).toEqual([15.5, 16.1]);
    expect(result.resonances.find((resonance) => resonance.deltaPpm === 15.5)?.equivalentNuclei).toBe(2);
    expect(result.backend.method).toBe("hose-fragment");
    expect(result.resonances[0].evidence?.matchedSphere).toBeGreaterThanOrEqual(1);
    expect(() => NmrPredictionResultSchema.parse(result)).not.toThrow();
  });

  it("emits applicable unmatched rules with exact per-estimate provenance", async () => {
    const result = await predict(new OclHosePredictor({ database: database() }), "CCC");
    expect(result.warnings.map((warning) => warning.code)).toContain("NMR_RULE_ESTIMATED");
    const estimated = result.resonances.filter((resonance) => resonance.evidence?.method === "rule-estimated");
    expect(estimated.length).toBeGreaterThan(0);
    expect(estimated.every((resonance) => resonance.flags.includes("rule-estimated"))).toBe(true);
    expect(estimated.every((resonance) => resonance.evidence?.estimator?.id === "chemdraft.functional-group-rules")).toBe(true);
    expect(estimated.every((resonance) => resonance.evidence?.estimator?.version === "1.1.0")).toBe(true);
  });

  it("omits unsupported unmatched silicon environments instead of fabricating shifts", async () => {
    const result = await predict(new OclHosePredictor({ database: database() }), "C[Si](C)(C)C");
    expect(result.resonances).toHaveLength(0);
    expect(result.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(["NMR_UNSUPPORTED_ELEMENT", "NMR_NO_FRAGMENT_MATCH", "NMR_PARTIAL_PREDICTION"])
    );
    expect(result.warnings.find((warning) => warning.code === "NMR_NO_FRAGMENT_MATCH")?.details).toMatchObject({
      estimateInapplicableReason: "unsupported-substituent"
    });
  });

  it.each([
    ["imine", "CC=N", 1, "unsupported-bonding-environment"],
    ["nitrile", "CC#N", 1, "unsupported-bonding-environment"]
  ])("omits an unmatched multiply bonded heteroatom %s carbon", async (_name, smiles, atom, reason) => {
    const result = await predict(new OclHosePredictor({ database: database() }), smiles);
    expect(
      result.resonances.some((resonance) => resonance.atomRefs.some((ref) => ref.sourceAtomIndex === atom))
    ).toBe(false);
    expect(
      result.warnings.some(
        (warning) =>
          warning.code === "NMR_NO_FRAGMENT_MATCH" &&
          warning.atomIndices?.includes(atom) &&
          warning.details?.estimateInapplicableReason === reason
      )
    ).toBe(true);
  });

  it("does not apply the benzene carbon rule to an unmatched heteroaromatic ring", async () => {
    const result = await predict(new OclHosePredictor({ database: database() }), "n1ccccc1");
    expect(result.resonances).toHaveLength(0);
    expect(
      result.warnings.some(
        (warning) => warning.details?.estimateInapplicableReason === "heteroaromatic-ring"
      )
    ).toBe(true);
  });

  it("honors options.statistic for both median and mean", async () => {
    const compiled = shallowDatabase("CC", "13C", { median: 11, mean: 19 });
    const predictor = new OclHosePredictor({ database: compiled });
    expect((await predict(predictor, "CC", "13C", "median")).resonances[0].deltaPpm).toBe(11);
    expect((await predict(predictor, "CC", "13C", "mean")).resonances[0].deltaPpm).toBe(19);
  });

  it.each([
    ["pyrimidine", "n1ccncc1"],
    ["dimethyl sulfide", "CSC"],
    ["acetaldimine", "CC=N"]
  ])("preserves the HOSE value and offers no invalid increment for %s", async (_name, smiles) => {
    const predictor = new OclHosePredictor({ database: shallowDatabase(smiles, "1H", { median: 8.66, mean: 8.8 }) });
    const result = await predict(predictor, smiles, "1H");
    expect(result.resonances.length).toBeGreaterThan(0);
    expect(result.resonances.every((resonance) => resonance.deltaPpm === 8.66)).toBe(true);
    expect(result.resonances.every((resonance) => resonance.crossCheck === undefined)).toBe(true);
  });

  it("retains an additive comparison for low-confidence fused carbocyclic PAH matches", async () => {
    const smiles = "c1ccc2ccccc2c1";
    const result = await predict(
      new OclHosePredictor({ database: shallowDatabase(smiles, "1H", { median: 7.8, mean: 7.8 }) }),
      smiles,
      "1H"
    );

    expect(result.resonances.some((resonance) => resonance.crossCheck !== undefined)).toBe(true);
    expect(
      result.resonances
        .filter((resonance) => resonance.crossCheck)
        .every(
          (resonance) =>
            resonance.crossCheck?.estimator?.id === "chemdraft.h1-additive-increment" &&
            resonance.crossCheck.estimator?.version === "1.3.0" &&
            resonance.crossCheck.estimator?.method === "aromatic-substituent-increment"
        )
    ).toBe(true);
    expect(
      result.resonances
        .filter((resonance) => resonance.crossCheck)
        .every((resonance) => resonance.crossCheck?.reason === "weak-applicability")
    ).toBe(true);
  });

  it("offers a second opinion for a specific but high-dispersion 1H match", async () => {
    const predictor = new OclHosePredictor({
      database: databaseAtSphere("CC", "1H", 2, { median: 0.9, mean: 2.0, stdev: 0.5, n: 25 })
    });
    const median = await predict(predictor, "CC", "1H", "median");
    const mean = await predict(predictor, "CC", "1H", "mean");

    expect(median.resonances[0]).toMatchObject({
      deltaPpm: 0.9,
      evidence: { matchedSphere: 2, sampleCount: 25 },
      crossCheck: {
        incrementPpm: 0.9,
        disagrees: false,
        reason: "high-dispersion",
        estimator: { version: "1.3.0", method: "shoolery-alpha-beta-gamma" }
      }
    });
    expect(mean.resonances[0]).toMatchObject({
      deltaPpm: 2.0,
      crossCheck: { incrementPpm: 0.9, disagrees: true, reason: "high-dispersion" }
    });
    expect(() => NmrPredictionResultSchema.parse(median)).not.toThrow();
  });

  it("uses estimator v1.3 provenance for unmatched 1H rule fallbacks", async () => {
    const result = await predict(new OclHosePredictor({ database: database() }), "CCCO", "1H");
    const estimated = result.resonances.filter((resonance) => resonance.evidence?.method === "rule-estimated");
    expect(estimated.length).toBeGreaterThan(0);
    expect(
      estimated.every((resonance) => {
        const estimator = resonance.evidence?.method === "rule-estimated" ? resonance.evidence.estimator : undefined;
        return (
          estimator?.id === "chemdraft.h1-additive-increment" &&
          estimator.version === "1.3.0" &&
          estimator.method === "shoolery-alpha-beta-gamma"
        );
      })
    ).toBe(true);
  });

  it("keeps an applicable comparison available for a specific low-dispersion match", async () => {
    const result = await predict(
      new OclHosePredictor({ database: databaseAtSphere("CC", "1H", 2, { stdev: 0.49, n: 25 }) }),
      "CC",
      "1H"
    );
    expect(result.resonances.every((resonance) => resonance.crossCheck?.reason === "routine-applicability")).toBe(true);
    expect(result.resonances.every((resonance) => resonance.crossCheck?.estimator?.version === "1.3.0")).toBe(true);
  });

  it("does not force an inapplicable increment onto a high-dispersion heteroaromatic match", async () => {
    const smiles = "n1ccncc1";
    const result = await predict(
      new OclHosePredictor({ database: databaseAtSphere(smiles, "1H", 2, { stdev: 0.8, n: 25 }) }),
      smiles,
      "1H"
    );
    expect(result.resonances.length).toBeGreaterThan(0);
    expect(result.resonances.every((resonance) => resonance.crossCheck === undefined)).toBe(true);
  });

  it("preserves normalization warnings and suppresses increment cross-checks for charged structures", async () => {
    const smiles = "C[N+](C)(C)C";
    const result = await predict(
      new OclHosePredictor({ database: shallowDatabase(smiles, "1H", { median: 3.2 }) }),
      smiles,
      "1H"
    );
    expect(result.warnings.map((warning) => warning.code)).toContain("NMR_CHARGED_STRUCTURE");
    expect(result.resonances.every((resonance) => resonance.crossCheck === undefined)).toBe(true);
  });

  it.each([
    ["a stereocentre-containing chain", "C[C@H](F)CO", [3]],
    ["terminal vinyl CH2 in propene", "CC=C", [2]],
    ["ring CH2 sites in methylcyclohexane", "CC1CCCCC1", [2, 3, 4, 5, 6]]
  ] as const)("warns for diastereotopic hydrogens at %s without splitting them", async (_name, smiles, atoms) => {
    const result = await predict(
      new OclHosePredictor({ database: databaseAtSphere(smiles, "1H", 2) }),
      smiles,
      "1H"
    );
    const warning = result.warnings.find(
      (candidate) => candidate.code === "NMR_POTENTIALLY_DIASTEREOTOPIC_HYDROGENS"
    );
    expect(warning?.atomIndices).toEqual(atoms);
    expect(warning?.message).toContain("distinct OpenChemLib diastereotopic hydrogen IDs");
    expect(warning?.message).toContain("does not predict separate diastereotopic values");
    for (const atom of atoms) {
      expect(
        result.resonances.filter((resonance) =>
          resonance.atomRefs.some((ref) => ref.sourceAtomIndex === atom)
        )
      ).toHaveLength(1);
    }
  });

  it.each([
    ["ethylene", "C=C"],
    ["dichloromethane", "C(Cl)Cl"],
    ["ethanol", "CCO"],
    ["diethyl ether", "CCOCC"]
  ])("does not raise the diastereotopic-hydrogen disclosure for %s", async (_name, smiles) => {
    const result = await predict(
      new OclHosePredictor({ database: databaseAtSphere(smiles, "1H", 2) }),
      smiles,
      "1H"
    );
    expect(result.warnings.map((warning) => warning.code)).not.toContain(
      "NMR_POTENTIALLY_DIASTEREOTOPIC_HYDROGENS"
    );
  });

  it("emits the general stereo-merge disclosure for a proton class too", async () => {
    const smiles = "CC(C)=CCO";
    const result = await predict(
      new OclHosePredictor({ database: databaseAtSphere(smiles, "1H", 1) }),
      smiles,
      "1H"
    );
    const warning = result.warnings.find(
      (candidate) => candidate.code === "NMR_STEREO_NONEQUIVALENT_MERGED"
    );
    expect(warning?.atomIndices).toEqual([0, 2]);
    expect(warning?.details?.nucleus).toBe("1H");
  });

  it.each([
    ["prenol", "CC(C)=CCO", [0, 2], [[0, 2]]],
    ["a multi-stereocenter chain", "C[C@H](O)C(Cl)[C@@H](O)C", [0, 1, 5, 7], [[0, 7], [1, 5]]],
    [
      "an E/Z mixture",
      "C/C=C/C.C/C=C\\C",
      [0, 1, 2, 3, 4, 5, 6, 7],
      [[0, 3, 4, 7], [1, 2, 5, 6]]
    ]
  ] as const)(
    "discloses stereochemically distinct members of an emitted constitutional class for %s without splitting shifts",
    async (_name, smiles, warnedAtoms, mergedClasses) => {
      const result = await predict(
        new OclHosePredictor({ database: databaseAtSphere(smiles, "13C", 1) }),
        smiles,
        "13C"
      );
      const warning = result.warnings.find(
        (candidate) => candidate.code === "NMR_STEREO_NONEQUIVALENT_MERGED"
      );

      expect(warning?.atomIndices).toEqual(warnedAtoms);
      expect(warning?.message).toContain("may give separate signals");
      expect(warning?.message).toContain("does not predict separate values");
      for (const expectedClass of mergedClasses) {
        expect(
          result.resonances.filter((resonance) =>
            expectedClass.every((atom) => resonance.atomRefs.some((ref) => ref.sourceAtomIndex === atom))
          )
        ).toHaveLength(1);
      }
    }
  );

  it.each([
    ["(R,R)-2,3-dibromobutane", "C[C@H](Br)[C@H](Br)C"],
    ["meso-2,3-dibromobutane", "C[C@H](Br)[C@@H](Br)C"],
    ["glycerol", "OCC(O)CO"]
  ])("does not report a false stereochemical class merge for %s", async (_name, smiles) => {
    const result = await predict(
      new OclHosePredictor({ database: databaseAtSphere(smiles, "13C", 1) }),
      smiles,
      "13C"
    );
    expect(result.warnings.map((warning) => warning.code)).not.toContain(
      "NMR_STEREO_NONEQUIVALENT_MERGED"
    );
  });

  it.each([
    ["stereo-annotated", "C[C@@H](O)C(C)C"],
    ["racemic", "CC(O)C(C)C"]
  ])("warns once per nucleus for %s potentially diastereotopic geminal methyls", async (_name, smiles) => {
    const result = await new OclHosePredictor({ now: () => "t" }).predict({
      structure: { format: "molfile-v2000", value: OCL.Molecule.fromSmiles(smiles).toMolfile() },
      nuclei: ["13C", "1H"],
      options: OPTIONS
    });
    const warnings = result.warnings.filter(
      (warning) => warning.code === "NMR_POTENTIALLY_DIASTEREOTOPIC_METHYLS"
    );

    expect(warnings).toHaveLength(2);
    expect(() => NmrPredictionResultSchema.parse(result)).not.toThrow();
    expect(warnings.map((warning) => warning.details?.nucleus).sort()).toEqual(["13C", "1H"]);
    for (const warning of warnings) {
      expect(warning.severity).toBe("info");
      expect(warning.atomIndices).toEqual([4, 5]);
      expect(warning.details?.methylPairCount).toBe(1);
      expect(warning.message).toContain("does not predict separate diastereotopic values");
    }
    expect(result.warnings.map((warning) => warning.code)).not.toContain(
      "NMR_STEREO_NONEQUIVALENT_MERGED"
    );
  });

  it.each([
    ["2-methylpropane", "CC(C)C"],
    ["tert-butanol", "CC(C)(C)O"],
    ["achiral isopropanol", "CC(C)O"]
  ])("does not warn for %s methyls", async (_name, smiles) => {
    const result = await new OclHosePredictor({ now: () => "t" }).predict({
      structure: { format: "molfile-v2000", value: OCL.Molecule.fromSmiles(smiles).toMolfile() },
      nuclei: ["13C", "1H"],
      options: OPTIONS
    });

    expect(result.warnings.map((warning) => warning.code)).not.toContain(
      "NMR_POTENTIALLY_DIASTEREOTOPIC_METHYLS"
    );
  });

  it("scopes legacy methyl and methylene stereogenicity checks to the group's connected component", async () => {
    const methylMixture = "CC(C)O.C[C@H](F)Cl";
    const methylResult = await new OclHosePredictor({ now: () => "t" }).predict({
      structure: { format: "smiles", value: methylMixture },
      nuclei: ["13C", "1H"],
      options: OPTIONS
    });
    expect(methylResult.warnings.map((warning) => warning.code)).not.toContain(
      "NMR_POTENTIALLY_DIASTEREOTOPIC_METHYLS"
    );
    expect(methylResult.warnings.map((warning) => warning.code)).not.toContain(
      "NMR_STEREO_NONEQUIVALENT_MERGED"
    );

    const methyleneMixture = "CCC.C[C@H](F)Cl";
    const methyleneResult = await predict(
      new OclHosePredictor({ database: databaseAtSphere(methyleneMixture, "1H", 1) }),
      methyleneMixture,
      "1H"
    );
    expect(methyleneResult.warnings.map((warning) => warning.code)).not.toContain(
      "NMR_POTENTIALLY_DIASTEREOTOPIC_HYDROGENS"
    );
  });

  it("treats zero-order metal-ligand bonds as component connections", async () => {
    // Isopropanol and the chiral alkyl fragment are linked only through the two V2000 type-8
    // (zero-order metal-ligand) bonds to iron.
    const molfile = `
Actelion Java MolfileCreator 1.0

  9  8  0  0  1  0  0  0  0  0999 V2000
   -0.1340   -0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    0.8660   -0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    1.3660   -0.8660    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    1.3660    0.8660    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0
    4.4660    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    3.4660    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    2.9660    0.8660    0.0000 F   0  0  0  0  0  0  0  0  0  0  0  0
    2.9660   -0.8660    0.0000 Cl  0  0  0  0  0  0  0  0  0  0  0  0
    2.2000    0.0000    0.0000 Fe  0  0  0  0  0  0  0  0  0  0  0  0
  1  2  1  0  0  0  0
  2  3  1  0  0  0  0
  2  4  1  0  0  0  0
  5  6  1  0  0  0  0
  6  7  1  1  0  0  0
  6  8  1  0  0  0  0
  2  9  8  0  0  0  0
  6  9  8  0  0  0  0
M  END
`;
    const parsed = OCL.Molecule.fromMolfile(molfile);
    expect([6, 7].map((bond) => parsed.getBondOrder(bond))).toEqual([0, 0]);

    const result = await new OclHosePredictor({ now: () => "t" }).predict({
      structure: { format: "molfile-v2000", value: molfile },
      nuclei: ["13C", "1H"],
      options: OPTIONS
    });
    expect(
      result.warnings.filter((warning) => warning.code === "NMR_POTENTIALLY_DIASTEREOTOPIC_METHYLS")
    ).toHaveLength(2);
  });

  it("keeps the tert-butyl exclusion when another carbon in the component is stereogenic", async () => {
    const smiles = "C[C@H](O)C(C)(C)C";
    const result = await new OclHosePredictor({ now: () => "t" }).predict({
      structure: { format: "smiles", value: smiles },
      nuclei: ["13C", "1H"],
      options: OPTIONS
    });
    expect(result.warnings.map((warning) => warning.code)).not.toContain(
      "NMR_POTENTIALLY_DIASTEREOTOPIC_METHYLS"
    );
  });

  it.each([
    ["ethane", "CC"],
    ["benzene", "c1ccccc1"],
    ["cyclohexane", "C1CCCCC1"]
  ])("reports the chemically equivalent protons of %s as a singlet", async (_name, smiles) => {
    const result = await predict(
      new OclHosePredictor({ database: shallowDatabase(smiles, "1H", { median: 1.2 }) }),
      smiles,
      "1H"
    );
    expect(result.resonances).toHaveLength(1);
    expect(result.resonances[0].multiplet).toEqual({ label: "s", couplings: [] });
    expect(result.warnings.map((warning) => warning.code)).not.toContain(
      "NMR_SECOND_ORDER_PATTERN_LIKELY"
    );
  });

  it("keeps ethanol's first-order triplet/quartet pattern", async () => {
    const smiles = "CCO";
    const result = await predict(
      new OclHosePredictor({ database: shallowDatabase(smiles, "1H", { median: 2 }) }),
      smiles,
      "1H"
    );
    const byAtom = new Map(
      result.resonances.map((resonance) => [resonance.atomRefs[0].sourceAtomIndex, resonance.multiplet?.label])
    );
    expect(byAtom.get(0)).toBe("t");
    expect(byAtom.get(1)).toBe("q");
    expect(result.warnings.map((warning) => warning.code)).not.toContain(
      "NMR_SECOND_ORDER_PATTERN_LIKELY"
    );
  });

  it("keeps p-xylene's isolated isochronous aromatic class as a singlet without a second-order warning", async () => {
    const smiles = "Cc1ccc(C)cc1";
    const result = await predict(
      new OclHosePredictor({ database: shallowDatabase(smiles, "1H", { median: 7 }) }),
      smiles,
      "1H"
    );
    const aromatic = result.resonances.find((resonance) =>
      resonance.atomRefs.some((ref) => ref.sourceAtomIndex === 2)
    );
    expect(aromatic).toMatchObject({ equivalentNuclei: 4, multiplet: { label: "s", couplings: [] } });
    expect(result.warnings.map((warning) => warning.code)).not.toContain(
      "NMR_SECOND_ORDER_PATTERN_LIKELY"
    );
  });

  it.each([
    ["p-bromochlorobenzene", "Clc1ccc(Br)cc1", [2, 3, 6, 7]],
    ["1,2-dichlorobenzene", "Clc1ccccc1Cl", [2, 3, 4, 5]],
    ["(R,R)-2,3-dibromobutane", "C[C@H](Br)[C@H](Br)C", [0, 1, 3, 5]],
    ["meso-2,3-dibromobutane", "C[C@H](Br)[C@@H](Br)C", [0, 1, 3, 5]],
    ["(E)-2-butene", "C/C=C/C", [0, 1, 2, 3]],
    ["(Z)-2-butene", "C/C=C\\C", [0, 1, 2, 3]],
    ["toluene", "Cc1ccccc1", [2, 3, 5, 6]]
  ] as const)("discloses magnetically nonequivalent coupled classes for %s", async (_name, smiles, atomIndices) => {
    const result = await predict(
      new OclHosePredictor({ database: shallowDatabase(smiles, "1H", { median: 7 }) }),
      smiles,
      "1H"
    );
    const warning = result.warnings.find(
      (candidate) => candidate.code === "NMR_SECOND_ORDER_PATTERN_LIKELY"
    );
    expect(warning?.atomIndices).toEqual(atomIndices);
    expect(warning?.message).toContain("full spin analysis may be needed");
    expect(warning?.message).toContain("not an exact pattern");
  });

  it.each([
    ["p-xylene", "Cc1ccc(C)cc1"],
    ["benzene", "c1ccccc1"],
    ["cyclohexane", "C1CCCCC1"],
    ["ethane", "CC"],
    ["1,3-dichlorobenzene", "Clc1cccc(Cl)c1"],
    ["ethanol", "CCO"]
  ])("does not warn for magnetically equivalent or externally uncoupled classes in %s", async (_name, smiles) => {
    const result = await predict(
      new OclHosePredictor({ database: shallowDatabase(smiles, "1H", { median: 7 }) }),
      smiles,
      "1H"
    );
    expect(result.warnings.map((warning) => warning.code)).not.toContain(
      "NMR_SECOND_ORDER_PATTERN_LIKELY"
    );
  });

  it("keeps magnetic-equivalence analysis component-local when a molecule is duplicated", async () => {
    const smiles = "Clc1cc(Br)ccc1F";
    const predictor = (structure: string) =>
      predict(
        new OclHosePredictor({ database: shallowDatabase(structure, "1H", { median: 7 }) }),
        structure,
        "1H"
      );
    const [single, duplicated] = await Promise.all([predictor(smiles), predictor(`${smiles}.${smiles}`)]);

    expect(single.warnings.map((warning) => warning.code)).not.toContain(
      "NMR_SECOND_ORDER_PATTERN_LIKELY"
    );
    expect(duplicated.warnings.map((warning) => warning.code)).not.toContain(
      "NMR_SECOND_ORDER_PATTERN_LIKELY"
    );
  });

  it("does not disclose a geminal vinylic class without an estimated external proton coupling", async () => {
    const smiles = "FC(F)=C";
    const result = await predict(
      new OclHosePredictor({ database: shallowDatabase(smiles, "1H", { median: 5 }) }),
      smiles,
      "1H"
    );
    expect(result.warnings.map((warning) => warning.code)).not.toContain(
      "NMR_SECOND_ORDER_PATTERN_LIKELY"
    );
  });

  it("keeps strychnine HOSE-first while exposing its applicable vinylic increment comparison", async () => {
    // ChEBI 28973; this is the user-reported bridged/chiral regression structure from M25.
    const smiles = "[H][C@@]12N3C(=O)C[C@]4([H])OCC=C5CN6CC[C@@]1(c1ccccc13)[C@]6([H])C[C@]5([H])[C@]24[H]";
    const result = await predict(new OclHosePredictor({ now: () => "t" }), smiles, "1H");
    const vinylic = result.resonances.find(
      (resonance) => resonance.crossCheck?.estimator?.method === "functional-class-vinylic"
    );

    expect(vinylic).toMatchObject({
      deltaPpm: 5.84,
      crossCheck: {
        incrementPpm: 5.7,
        disagrees: false,
        reason: "routine-applicability",
        estimator: { version: "1.3.0" }
      }
    });
    expect(result.warnings.map((warning) => warning.code)).toContain(
      "NMR_POTENTIALLY_DIASTEREOTOPIC_HYDROGENS"
    );
  });

  it("treats a canonical nitro group as a supported table class without an ionic-chemistry warning", async () => {
    const smiles = "O=[N+]([O-])c1ccccc1";
    const result = await predict(
      new OclHosePredictor({ database: shallowDatabase(smiles, "1H", { median: 8.2 }) }),
      smiles,
      "1H"
    );
    expect(result.warnings.map((warning) => warning.code)).not.toContain("NMR_CHARGED_STRUCTURE");
    expect(result.resonances.some((resonance) => resonance.crossCheck?.estimator?.id === "chemdraft.h1-additive-increment")).toBe(true);
  });

  it("splits shallow-code groups when atoms have different increment cross-checks", async () => {
    const smiles = "COc1ccccc1";
    const result = await predict(
      new OclHosePredictor({ database: shallowDatabase(smiles, "1H", { median: 8.5, mean: 8.5 }) }),
      smiles,
      "1H"
    );
    const byCode = new Map<string, typeof result.resonances>();
    for (const resonance of result.resonances) {
      const code = resonance.evidence?.environmentCode ?? "";
      byCode.set(code, [...(byCode.get(code) ?? []), resonance]);
    }
    const split = [...byCode.values()].find(
      (group) => group.length > 1 && new Set(group.map((resonance) => resonance.crossCheck?.incrementPpm)).size > 1
    );
    expect(split).toBeDefined();
    expect(split?.every((resonance) => resonance.crossCheck?.estimator?.id === "chemdraft.h1-additive-increment")).toBe(true);
  });

  it("does not count a symmetry-equivalent ethane host as its own coupling partner", async () => {
    const smiles = "CC";
    const result = await predict(
      new OclHosePredictor({ database: shallowDatabase(smiles, "1H", { median: 1.2 }) }),
      smiles,
      "1H"
    );

    expect(result.resonances).toHaveLength(1);
    expect(result.resonances[0]).toMatchObject({ equivalentNuclei: 6, multiplet: { label: "s" } });
    expect(result.resonances[0].atomRefs.map((ref) => ref.sourceAtomIndex).sort((a, b) => a - b)).toEqual([0, 1]);
  });

  it("uses the bundled NMRShiftDB2 database and surfaces its provenance", async () => {
    const predictor = new OclHosePredictor({ now: () => "t" });
    expect(await predictor.getCapabilities()).toMatchObject({ id: "chemdraft.ocl-hose", supportsUncertainty: true });

    const result = await predict(predictor, "CC(=O)C");
    expect(result.backend.method).toBe("hose-fragment");
    expect(result.backend.dataVersion).toContain("NMRShiftDB2");
    expect(result.backend.license).toBeTruthy();
    expect(result.backend.attribution).toBeTruthy();
    // M30: the refreshed artifact records the exact raw corpus it was compiled from; the backend
    // surfaces it so the report layer can attach benchmark results to precisely this data.
    expect(result.backend.dataChecksum).toBe("831a31e78b004a308c7c40989e27d30698a34c506e722a91c78b6ed448fc4720");
    expect(predictor.provenance).toMatchObject({ minObservations: 5, rawEntryCount: 533324 });
    expect(result.resonances.length).toBeGreaterThan(0);
    expect(result.resonances.some((resonance) => resonance.evidence?.method === "hose-fragment")).toBe(true);
    for (const resonance of result.resonances) {
      const sd = resonance.uncertainty?.standardDeviationPpm;
      expect(sd === undefined || typeof sd === "number").toBe(true);
      if (resonance.evidence?.method === "hose-fragment") {
        expect(resonance.evidence.sampleCount).toBeGreaterThan(0);
      }
    }
  });

  it("emits 2D depiction geometry whose atom indices align with resonance atomRefs", async () => {
    const result = await predict(new OclHosePredictor({ now: () => "t" }), "CC(=O)C");
    const depiction = result.depiction;
    expect(depiction).toBeDefined();
    if (!depiction) return;

    expect(depiction.atoms).toHaveLength(4);
    expect(depiction.bonds.length).toBeGreaterThanOrEqual(3);
    const atomIndices = new Set(depiction.atoms.map((atom) => atom.index));
    for (const resonance of result.resonances) {
      for (const ref of resonance.atomRefs) expect(atomIndices.has(ref.sourceAtomIndex)).toBe(true);
    }
    for (const bond of depiction.bonds) {
      expect(atomIndices.has(bond.from)).toBe(true);
      expect(atomIndices.has(bond.to)).toBe(true);
      expect(bond.order).toBeGreaterThanOrEqual(1);
      expect(bond.order).toBeLessThanOrEqual(3);
    }
  });
});
