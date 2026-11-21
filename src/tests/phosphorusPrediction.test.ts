import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Molecule } from "openchemlib";
import { describe, expect, it } from "vitest";

import { determineAnalysisStatus } from "../application/determineAnalysisStatus";
import type { ChemicalStructureInput, NmrNucleus, NmrPredictionRequest } from "../domain/contracts";
import { NmrPredictionRequestSchema, NmrPredictionResultSchema } from "../domain/schemas";
import { NmrWarningCodes } from "../domain/warnings";
import {
  bootstrapPhosphorusErrors,
  evaluateHeldOut,
  sourceReferenceBucket,
  sourceReferenceKey,
  splitCorpusBySourceReference
} from "../providers/ocl/benchmark";
import { buildNmrDatabase } from "../providers/ocl/buildDatabase";
import bundledPhosphorusDatabase from "../providers/ocl/ilm-nmr-p31.database.json";
import type { CompiledNmrDatabase } from "../providers/ocl/localDatabase";
import { parseNmredataRecords } from "../providers/ocl/nmredata";
import { MEASURED_ACCURACY, PHOSPHORUS_MEASURED_ACCURACY } from "../providers/ocl/measuredAccuracy";
import { OclHosePredictor } from "../providers/ocl/OclHosePredictor";
import { prepareProductionLookup, productionEnvironmentCodes } from "../providers/ocl/productionLookup";
import { composePredictionReport } from "../report/composePredictionReport";
import baselines from "./fixtures/noDeuteriumOutput.json";

// Hand-written synthetic fixtures for compiler and lookup behavior.
const twoPhosphorus = `synthetic two phosphorus environments
  synthetic        2D

  4  2  0  0  0  0  0  0  0  0999 V2000
    0.0000    0.0000    0.0000 P   0  0  0  0  0  0  0  0  0  0  0  0
    1.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    3.0000    0.0000    0.0000 P   0  0  0  0  0  0  0  0  0  0  0  0
    4.0000    0.0000    0.0000 Cl  0  0  0  0  0  0  0  0  0  0  0  0
  1  2  1  0  0  0  0
  3  4  1  0  0  0  0
M  END`;

const equivalentPhosphorus = `synthetic equivalent phosphorus pair
  synthetic        2D

  2  1  0  0  0  0  0  0  0  0999 V2000
    0.0000    0.0000    0.0000 P   0  0  0  0  0  0  0  0  0  0  0  0
    1.0000    0.0000    0.0000 P   0  0  0  0  0  0  0  0  0  0  0  0
  1  2  1  0  0  0  0
M  END`;

const stereochemicalPhosphorus = `synthetic stereochemical pair
  synthetic        2D

  5  4  0  0  1  0  0  0  0  0999 V2000
    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    1.0000    1.0000    0.0000 P   0  0  0  0  0  0  0  0  0  0  0  0
    1.0000   -1.0000    0.0000 F   0  0  0  0  0  0  0  0  0  0  0  0
   -1.0000   -1.0000    0.0000 Cl  0  0  0  0  0  0  0  0  0  0  0  0
   -1.0000    1.0000    0.0000 Br  0  0  0  0  0  0  0  0  0  0  0  0
  1  2  1  1  0  0  0
  1  3  1  0  0  0  0
  1  4  1  0  0  0  0
  1  5  1  0  0  0  0
M  END`;

function sdf(molfile: string, assignments: string, spectrum: string): string {
  return `${molfile}\n> <NMREDATA_ASSIGNMENT>\n${assignments}\n\n> <NMREDATA_1D_31P>\n${spectrum}\n\n$$$$\n`;
}

const oneAssigned = sdf(twoPhosphorus, "P1, -7.5, 1", "-7.5, L=P1");
const bothAssigned = sdf(twoPhosphorus, "P1, -7.5, 1\nP3, 13.5, 3", "-7.5, L=P1\n13.5, L=P3");
const equivalentAssigned = sdf(equivalentPhosphorus, "P1, 5, 1 2", "5, L=P1");
const provenance = { name: "synthetic", version: "1", source: "synthetic", license: "synthetic", attribution: "synthetic", note: "synthetic" };
const stereoMergedPhosphorusDatabase: CompiledNmrDatabase = {
  provenance: { ...provenance, nuclei: ["31P"], structureCount: 1, entryCount: 1, generatedAt: "t" },
  entries: {
    // Synthetic shift for the phosphorus environment in PC(P)=CCO.
    "31P@Pq0h2(1Cq0h0)(1Pq0h2,2Cq0h1)(1Cq0h2)(1Oq0h1)": {
      nucleus: "31P", sphere: 4, n: 3, median: 5, mean: 5, stdev: 0, min: 5, max: 5
    }
  }
};
const options = { statistic: "median" as const, hoseLevels: [4, 3, 2, 1], ignoreLabileHydrogens: true };

function database(raw: string, inputSha256?: string) {
  return buildNmrDatabase(raw, { provenance: { ...provenance, inputSha256 }, now: () => "t" });
}

function request(value: string, nuclei: readonly NmrNucleus[] = ["31P"]): NmrPredictionRequest {
  return { structure: { format: "smiles", value }, nuclei, options };
}

describe("31P HOSE prediction", () => {
  it("predicts from the bundled phosphorus table and displays its measured accuracy", async () => {
    const predictor = new OclHosePredictor();
    expect(predictor.getCapabilities().nuclei).toContain("31P");
    const smiles = "CCP(CC)CC";
    const result = NmrPredictionResultSchema.parse(await predictor.predict(request(smiles)));
    expect(result.resonances).toMatchObject([{
      nucleus: "31P",
      source: "lookup",
      evidence: { method: "hose-fragment" }
    }]);
    expect(result.resonances[0].evidence?.sampleCount).toBeGreaterThanOrEqual(5);
    expect(result.backend.dataChecksum).toBe(PHOSPHORUS_MEASURED_ACCURACY.corpusSha256);

    const report = composePredictionReport({
      objectId: "m1", structure: smiles, structureFormat: "smiles", sourceFingerprint: "triethylphosphine"
    }, result);
    const serialized = JSON.stringify(report);
    expect(serialized).toContain("Measured accuracy (³¹P)");
    expect(serialized).toContain(PHOSPHORUS_MEASURED_ACCURACY.partition);
  });

  it("compiles distinct P environments and counts equivalent P atoms once per assignment", () => {
    const db = database(bothAssigned + equivalentAssigned);
    expect(db.provenance.nuclei).toEqual(["31P"]);
    expect(db.provenance.structureCount).toBe(2);
    const deepest = Object.values(db.entries).filter(({ sphere }) => sphere === 4);
    expect(deepest.map(({ median, n }) => [median, n])).toEqual([[-7.5, 1], [13.5, 1], [5, 1]]);
    expect(evaluateHeldOut(db, parseNmredataRecords(equivalentAssigned))).toHaveLength(1);
  });

  it("includes a neighboring phosphorus charge at every lookup depth for 31P and 1H", () => {
    const neutral = prepareProductionLookup(Molecule.fromSmiles("PP"));
    const charged = prepareProductionLookup(Molecule.fromSmiles("P[PH2+]"));
    const neutralProtonCodes = productionEnvironmentCodes(neutral, "1H", 0);
    const neutralCodes = productionEnvironmentCodes(neutral, "31P", 0);
    const chargedCodes = productionEnvironmentCodes(charged, "31P", 0);
    expect(chargedCodes).toHaveLength(4);
    expect(chargedCodes).toEqual(neutralCodes.map((code) => code.replace("1Pq0h2", "1Pq1h2")));
    expect(chargedCodes.every((code) => code.includes("1Pq1h2"))).toBe(true);
    expect(neutralProtonCodes.every((code) => code.includes("(1Ph2)"))).toBe(true);
    expect(productionEnvironmentCodes(charged, "1H", 0)).toEqual(chargedCodes);
  });

  it.each([1, 2, 3, 4])("encodes a charged oxygen at sphere %i of a hypervalent phosphorus environment", (sphere) => {
    const prefix = `CP(=O)(C)${"C".repeat(sphere - 1)}`;
    const neutral = prepareProductionLookup(Molecule.fromSmiles(`${prefix}[O]`));
    const charged = prepareProductionLookup(Molecule.fromSmiles(`${prefix}[O-]`));
    const neutralCodes = productionEnvironmentCodes(neutral, "31P", 1);
    const chargedCodes = productionEnvironmentCodes(charged, "31P", 1);
    expect(chargedCodes.slice(0, 5 - sphere)).toEqual(
      neutralCodes.slice(0, 5 - sphere).map((code) => code.replace("1Oq0h0", "1Oq-1h0"))
    );
    expect(chargedCodes[4 - sphere]).toContain("1Oq-1h0");
    expect(chargedCodes.slice(5 - sphere)).toEqual(neutralCodes.slice(5 - sphere));
  });

  it("keeps statistics separate for neutral and charged P(V) substituents and preserves P=O and P=S bonds", async () => {
    const examples = [
      { smiles: "CP(=O)(C)[O]", shift: 1, doubleBond: "2Oq0h0" },
      { smiles: "CP(=O)(C)[O-]", shift: 10, doubleBond: "2Oq0h0" },
      { smiles: "CP(=S)(C)[O-]", shift: 20, doubleBond: "2Sq0h0" }
    ];
    const db = database(examples.map(({ smiles, shift }) =>
      sdf(Molecule.fromSmiles(smiles).toMolfile(), `P2, ${shift}, 2`, `${shift}, L=P2`)
    ).join(""));
    for (const sphere of [1, 2, 3, 4]) {
      const entries = Object.values(db.entries).filter((entry) => entry.sphere === sphere);
      expect(entries.map(({ median, n }) => [median, n])).toEqual([[1, 1], [10, 1], [20, 1]]);
    }
    const predictor = new OclHosePredictor({ phosphorusDatabase: db });
    for (const { smiles, shift, doubleBond } of examples) {
      const result = await predictor.predict(request(smiles));
      expect(result.resonances).toMatchObject([{
        nucleus: "31P", deltaPpm: shift,
        evidence: { matchedSphere: 4, sampleCount: 1, environmentCode: expect.stringContaining(doubleBond) }
      }]);
    }
  });

  it("reports one resonance without a stereo warning for a symmetry-equivalent pair of phosphorus atoms", async () => {
    const predictor = new OclHosePredictor({ phosphorusDatabase: database(equivalentAssigned) });
    const result = await predictor.predict(request("PP"));
    expect(result.resonances).toMatchObject([{
      nucleus: "31P", deltaPpm: 5, equivalentNuclei: 2,
      atomRefs: [
        { sourceAtomIndex: 0, element: "P", equivalentCount: 1 },
        { sourceAtomIndex: 1, element: "P", equivalentCount: 1 }
      ],
      evidence: { matchedSphere: 4, sampleCount: 1 }
    }]);
    expect(result.warnings.map(({ code }) => code)).not.toContain(NmrWarningCodes.StereoNonequivalentMerged);
  });

  it("discloses stereochemically distinct phosphorus atoms in a merged resonance", async () => {
    const predictor = new OclHosePredictor({ phosphorusDatabase: stereoMergedPhosphorusDatabase });
    const result = await predictor.predict(request("PC(P)=CCO"));
    expect(result.resonances).toMatchObject([{
      nucleus: "31P", deltaPpm: 5, equivalentNuclei: 2,
      atomRefs: [
        { sourceAtomIndex: 0, element: "P", equivalentCount: 1 },
        { sourceAtomIndex: 2, element: "P", equivalentCount: 1 }
      ]
    }]);
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: NmrWarningCodes.StereoNonequivalentMerged,
      atomIndices: [0, 2],
      details: { nucleus: "31P", mergedClassCount: 1 }
    }));
  });

  it("predicts from the deepest exact match using the shared HOSE evidence", async () => {
    const predictor = new OclHosePredictor({ phosphorusDatabase: database(bothAssigned) });
    expect(predictor.getCapabilities().nuclei).toContain("31P");
    const input = NmrPredictionRequestSchema.parse(request("CP"));
    const result = NmrPredictionResultSchema.parse(await predictor.predict(input));
    expect(result.resonances).toMatchObject([{
      nucleus: "31P", source: "lookup", deltaPpm: -7.5,
      atomRefs: [{ sourceAtomIndex: 1, element: "P" }],
      evidence: { method: "hose-fragment", matchedSphere: 4, sampleCount: 1 }
    }]);
    expect(result.resonances[0].crossCheck).toBeUndefined();
  });

  it("omits an unmatched P atom and assigns no shift", async () => {
    const predictor = new OclHosePredictor({ phosphorusDatabase: database(oneAssigned) });
    const result = await predictor.predict(request("PCl"));
    expect(result.resonances).toEqual([]);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: NmrWarningCodes.NoFragmentMatch, atomIndices: [0] }));
    expect(determineAnalysisStatus(result)).toBe("failed");
  });

  it("produces a partial result when one P matches and one is omitted", async () => {
    const predictor = new OclHosePredictor({ phosphorusDatabase: database(oneAssigned) });
    const result = await predictor.predict(request("PC.PCl"));
    expect(result.resonances.map(({ id, deltaPpm }) => [id, deltaPpm])).toEqual([["p-0", -7.5]]);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: NmrWarningCodes.NoFragmentMatch, atomIndices: [2] }));
    expect(result.warnings.map(({ code }) => code)).toContain(NmrWarningCodes.PartialPrediction);
    expect(determineAnalysisStatus(result)).toBe("partial");
  });

  it("declines with a specific warning when the table is absent", async () => {
    const predictor = new OclHosePredictor({ phosphorusDatabase: null });
    const result = await predictor.predict(request("CP"));
    expect(predictor.getCapabilities().nuclei).not.toContain("31P");
    expect(result.resonances).toEqual([]);
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: NmrWarningCodes.PhosphorusDatabaseNotInstalled,
      message: "³¹P database not installed"
    }));
  });

  it("shows phosphorus accuracy only for its own checksum, even in a mixed request", async () => {
    for (const checksum of [PHOSPHORUS_MEASURED_ACCURACY.corpusSha256, MEASURED_ACCURACY.corpusSha256, undefined]) {
      const predictor = new OclHosePredictor({ phosphorusDatabase: database(oneAssigned, checksum) });
      for (const nuclei of [["31P"], ["13C", "31P"]] as const) {
        const result = await predictor.predict(request("CP", nuclei));
        const report = composePredictionReport({
          objectId: "m1", structure: "CP", structureFormat: "smiles", sourceFingerprint: "synthetic"
        }, result);
        expect(JSON.stringify(report).includes("Measured accuracy (³¹P)")).toBe(checksum === PHOSPHORUS_MEASURED_ACCURACY.corpusSha256);
      }
    }
  });

  it("preserves the serialized 1H/13C result from the existing ethanol baseline with the bundled P table", async () => {
    const baseline = baselines[0];
    const predictor = new OclHosePredictor({ now: () => "t" });
    const result = await predictor.predict({
      structure: baseline.structure as ChemicalStructureInput, nuclei: ["1H", "13C"], options, sourceFingerprint: "regression"
    });
    expect(createHash("sha256").update(JSON.stringify(result)).digest("hex")).toBe(baseline.resultSha256);
  });
});

describe("31P benchmark", () => {
  it("prunes the training table at the same five-observation cutoff as the production build", () => {
    const root = mkdtempSync(join(tmpdir(), "nmr-p31-benchmark-"));
    const runScript = (script: string, ...args: string[]) => execFileSync(
      process.execPath,
      ["--import", "tsx", script, ...args],
      { cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8" }
    );
    try {
      const directory = join(root, "SDFs");
      mkdirSync(directory);
      const metadata = ['"num" "ref" "LM"'];
      const trainingRecords = [...Array<string>(5).fill(equivalentAssigned), ...Array<string>(4).fill(oneAssigned)];
      for (const [index, raw] of trainingRecords.entries()) {
        const stem = `train-CMP${index + 1}`;
        writeFileSync(join(directory, `${stem}.sdf`), raw);
        metadata.push(`${index + 1} "${stem}" "ref 0" "NA"`);
      }

      const production = JSON.parse(runScript("scripts/build-database.ts", directory, join(root, "production.json")));
      expect(production.minObservations).toBe(5);
      expect(production.minObservations).toBe(bundledPhosphorusDatabase.provenance.minObservations);
      expect(production.entryCount).toBe(4);
      expect(production.rawEntryCount).toBe(8);

      const heldOut = sdf(stereochemicalPhosphorus, "P2, 10, 2", "10, L=P2");
      writeFileSync(join(directory, "test-CMP1.sdf"), heldOut);
      const metadataPath = join(root, "metadata.csv");
      writeFileSync(metadataPath, [...metadata, '10 "test-CMP1" "ref 3" "NA"'].join("\n"));
      const benchmark = JSON.parse(runScript("scripts/run-benchmark.ts", directory, "--metadata", metadataPath));
      expect(benchmark.protocol).toMatchObject({
        train: 9,
        heldOut: 1,
        minObservations: production.minObservations,
        trainDatabaseEntries: production.entryCount
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("normalizes references, falls back to the entry stem, and hashes deterministically", () => {
    expect(sourceReferenceKey("other-CMP1", "\t REF\n  3 ")).toBe("ref 3");
    expect(sourceReferenceKey("example-CMP4", " NA ")).toBe("stem:example");
    expect(sourceReferenceKey("example-CMP17", "")).toBe("stem:example");
    expect(sourceReferenceBucket("stem:example")).toBe(173);
    expect(sourceReferenceBucket("ref 3")).toBe(32);
  });

  it("drops training duplicates of the test constitution even when their stereochemistry differs", () => {
    const inverted = stereochemicalPhosphorus.replace("  1  2  1  1", "  1  2  1  6");
    expect(Molecule.fromMolfile(inverted).getIDCode()).not.toBe(Molecule.fromMolfile(stereochemicalPhosphorus).getIDCode());
    const entries = [
      { stem: "test-CMP1", ref: " REF 3 ", raw: stereochemicalPhosphorus },
      { stem: "train-CMP1", ref: "ref 0", raw: inverted },
      { stem: "train-CMP2", ref: "ref 0", raw: equivalentPhosphorus }
    ];
    const split = splitCorpusBySourceReference(entries);
    expect(split).toEqual({
      train: [entries[2]], heldOut: [{ entry: entries[0], groupKey: "ref 3" }], droppedTrainingDuplicates: 1
    });
    expect(splitCorpusBySourceReference(entries)).toEqual(split);
  });

  it("resamples whole source groups with deterministic percentile intervals", () => {
    const rows = [
      { nucleus: "31P", structureIndex: 0, assignedPpm: 1, hosePpm: 1 },
      { nucleus: "31P", structureIndex: 1, assignedPpm: 3, hosePpm: 1 },
      { nucleus: "31P", structureIndex: 2, assignedPpm: 6, hosePpm: 1 }
    ] as const;
    expect(bootstrapPhosphorusErrors(rows, ["a", "a", "b"])).toEqual({ mae: [1, 5], rmse: [1.414, 5] });
  });
});
