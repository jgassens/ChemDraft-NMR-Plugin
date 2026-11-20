import { createHash } from "node:crypto";
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
import { parseNmredataRecords } from "../providers/ocl/nmredata";
import { MEASURED_ACCURACY, PHOSPHORUS_MEASURED_ACCURACY } from "../providers/ocl/measuredAccuracy";
import { OclHosePredictor } from "../providers/ocl/OclHosePredictor";
import { composePredictionReport } from "../report/composePredictionReport";
import baselines from "./fixtures/noDeuteriumOutput.json";

// Hand-written synthetic structures and shifts. No corpus entries are used in this file.
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
const options = { statistic: "median" as const, hoseLevels: [4, 3, 2, 1], ignoreLabileHydrogens: true };

function database(raw: string, inputSha256?: string) {
  return buildNmrDatabase(raw, { provenance: { ...provenance, inputSha256 }, now: () => "t" });
}

function request(value: string, nuclei: readonly NmrNucleus[] = ["31P"]): NmrPredictionRequest {
  return { structure: { format: "smiles", value }, nuclei, options };
}

describe("31P HOSE prediction", () => {
  it("compiles both P environments and counts equivalent P atoms as two observations", () => {
    const db = database(bothAssigned + equivalentAssigned);
    expect(db.provenance.nuclei).toEqual(["31P"]);
    expect(db.provenance.structureCount).toBe(2);
    const deepest = Object.values(db.entries).filter(({ sphere }) => sphere === 4);
    expect(deepest.map(({ median, n }) => [median, n])).toEqual([[-7.5, 1], [13.5, 1], [5, 2]]);
    expect(evaluateHeldOut(db, parseNmredataRecords(equivalentAssigned))).toHaveLength(2);
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
    const predictor = new OclHosePredictor();
    const result = await predictor.predict(request("CP"));
    expect(predictor.getCapabilities().nuclei).not.toContain("31P");
    expect(result.resonances).toEqual([]);
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: NmrWarningCodes.PhosphorusDatabaseNotInstalled,
      message: "31P database not installed"
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

  it("preserves the serialized 1H/13C result from the existing ethanol baseline with a P table supplied", async () => {
    const baseline = baselines[0];
    const predictor = new OclHosePredictor({ phosphorusDatabase: database(bothAssigned), now: () => "t" });
    const result = await predictor.predict({
      structure: baseline.structure as ChemicalStructureInput, nuclei: ["1H", "13C"], options, sourceFingerprint: "regression"
    });
    expect(createHash("sha256").update(JSON.stringify(result)).digest("hex")).toBe(baseline.resultSha256);
  });
});

describe("31P benchmark partition", () => {
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
