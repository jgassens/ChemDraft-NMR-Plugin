import { PluginPanelReportSchema, type PluginSelectedMolecule } from "@chemdraft/plugin-api";
import { describe, expect, it } from "vitest";

import type { NmrPredictionResult } from "../domain/contracts";
import { NmrPredictionResultSchema } from "../domain/schemas";
import { GNN_MEASURED_ACCURACY, GNN_MODEL_RELEASE } from "../providers/gnn/modelRelease";
import { MEASURED_ACCURACY } from "../providers/ocl/measuredAccuracy";
import { composePredictionReport } from "../report/composePredictionReport";

const source: PluginSelectedMolecule = {
  objectId: "m1",
  documentId: "doc1",
  pageId: "p1",
  structureFormat: "smiles",
  structure: "Cc1ccccc1",
  sourceFingerprint: "fp1"
};

/** A GNN-first ¹³C result: an agreeing high-tier GNN value, a disagreeing low-tier GNN value, and a
 *  HOSE lookup value shown because the GNN declined that atom. */
const gnnResult: NmrPredictionResult = {
  schemaVersion: "1",
  sourceFingerprint: "fp1",
  backend: {
    id: "chemdraft.gnn-hose",
    version: "2026-11-20",
    dataVersion: "NMRShiftDB2",
    method: "gnn",
    license: "nmrshiftdb2 Database License (ODbL-derived)",
    source: "https://sourceforge.net/projects/nmrshiftdb2/files/data/",
    dataChecksum: MEASURED_ACCURACY.corpusSha256,
    model: {
      id: GNN_MODEL_RELEASE.id,
      version: GNN_MODEL_RELEASE.version,
      nuclei: ["13C"],
      trainingData: GNN_MODEL_RELEASE.trainingData,
      dataLicense: GNN_MODEL_RELEASE.dataLicense
    }
  },
  resonances: [
    {
      id: "c-0",
      nucleus: "13C",
      source: "model",
      method: "GNN prediction",
      tier: "high",
      reference: { method: "HOSE lookup", deltaPpm: 21.4, matchedSphere: 4, sampleCount: 40, environmentCode: "Cq0h3(...)" },
      deltaPpm: 21.19,
      atomRefs: [{ sourceAtomIndex: 0, element: "C", equivalentCount: 1 }],
      equivalentNuclei: 1,
      evidence: { method: "gnn" },
      flags: []
    },
    {
      id: "c-1",
      nucleus: "13C",
      source: "model",
      method: "GNN prediction",
      tier: "low",
      reference: { method: "HOSE lookup", deltaPpm: 142.1, matchedSphere: 2, sampleCount: 9 },
      disagreesWithReference: true,
      deltaPpm: 137.4,
      atomRefs: [{ sourceAtomIndex: 1, element: "C", equivalentCount: 1 }],
      equivalentNuclei: 1,
      evidence: { method: "gnn" },
      flags: ["model-lookup-disagreement"]
    },
    {
      id: "c-2",
      nucleus: "13C",
      source: "lookup",
      method: "HOSE lookup",
      modelDeclines: ["element"],
      deltaPpm: 129.0,
      atomRefs: [{ sourceAtomIndex: 2, element: "C", equivalentCount: 1 }],
      equivalentNuclei: 2,
      uncertainty: { standardDeviationPpm: 0.8 },
      evidence: { method: "hose-fragment", matchedSphere: 3, sampleCount: 12, environmentCode: "Caq0h1(...)" },
      flags: []
    }
  ],
  warnings: [
    {
      code: "NMR_MODEL_LOOKUP_DISAGREEMENT",
      message: "¹³C atoms 1: model and reference lookup disagree (GNN prediction 137.40 ppm, HOSE lookup 142.10 ppm, agreement band 4 ppm).",
      severity: "warning",
      atomIndices: [1]
    }
  ],
  generatedAt: "t"
};

const sectionsJson = (report: { sections: unknown[] }) => JSON.stringify(report.sections);

describe("composePredictionReport for GNN results", () => {
  it("is a valid panel report built from a schema-valid result", () => {
    expect(NmrPredictionResultSchema.safeParse(gnnResult).success).toBe(true);
    expect(PluginPanelReportSchema.safeParse(composePredictionReport(source, gnnResult)).success).toBe(true);
  });

  it("shows each resonance's method label, its tier, and the HOSE value beside the GNN value", () => {
    const report = composePredictionReport(source, gnnResult);
    const table = report.sections.find((section) => section.kind === "table");
    if (!table || table.kind !== "table") throw new Error("no table");
    expect(table.columns.slice(0, 3)).toEqual(["Nucleus", "δ (ppm)", "Method"]);
    const confidence = table.columns.indexOf("Confidence");
    const rows = new Map(table.rows.map((row) => [row[1], row]));
    expect(rows.get("21.19")?.[2]).toBe("GNN prediction");
    expect(rows.get("21.19")?.[confidence]).toBe("high · HOSE 21.40 (s4, n=40)");
    expect(rows.get("137.40")?.[confidence]).toBe("low · model and reference lookup disagree · HOSE 142.10 (s2, n=9)");
    expect(rows.get("129.00")?.[2]).toBe("HOSE lookup");
    expect(rows.get("129.00")?.[confidence]).toBe("high · s3, n=12 · GNN declined (element)");
  });

  it("draws GNN tiers and offers the HOSE value as the comparison", () => {
    const report = composePredictionReport(source, gnnResult);
    const figure = report.sections.find((section) => section.kind === "linkedFigure");
    if (!figure || figure.kind !== "linkedFigure") throw new Error("no figure");
    expect(figure.spectrum.comparison).toEqual({ primaryLabel: "GNN", alternativeLabel: "HOSE lookup", alternativeMarker: "ₕ" });
    expect(figure.spectrum.peaks.map((peak) => [peak.ppm, peak.confidence, peak.alternativePpm])).toEqual([
      [21.19, "high", 21.4],
      [137.4, "low", 142.1],
      [129.0, "high", undefined]
    ]);
    expect(figure.caption).toContain("GNN-predicted spectrum");
  });

  it("names the method in the summary and states the partition next to every GNN accuracy figure", () => {
    const report = composePredictionReport(source, gnnResult);
    const json = sectionsJson(report);
    expect(json).toContain('"label":"Method","value":"GNN prediction + HOSE lookup"');
    expect(json).toContain(`"label":"Model","value":"${GNN_MODEL_RELEASE.id} ${GNN_MODEL_RELEASE.version}"`);
    const model = report.sections.find((section) => section.kind === "keyValue" && section.title === "GNN model");
    if (!model || model.kind !== "keyValue") throw new Error("no model section");
    const mae = model.rows.find((row) => row.label === "Measured MAE (¹³C)");
    expect(mae?.value).toContain(`${GNN_MEASURED_ACCURACY.maePpm["13C"]} ppm`);
    expect(mae?.value).toContain("scaffold-held-out test, 10% of Murcko scaffolds");
    expect(mae?.value).toContain("second, non-independent opening");
    expect(model.rows.find((row) => row.label === "Data license")?.value).toBe("nmrshiftdb2 Database License (ODbL-derived)");
    // Only the nuclei with GNN predictions get a figure.
    expect(model.rows.some((row) => row.label === "Measured MAE (¹H)")).toBe(false);
    // The HOSE table's own figure is labeled as the lookup's.
    expect(json).toContain("HOSE lookup measured accuracy (¹³C)");
  });

  it("contains no calibrated percentages, only tier names", () => {
    const report = composePredictionReport(source, gnnResult);
    // The only percent sign is the partition's own name ("10% of Murcko scaffolds").
    const json = sectionsJson(report).replaceAll(GNN_MEASURED_ACCURACY.partition, "<partition>");
    expect(json).not.toContain("%");
    expect(json).not.toMatch(/probabilit(y|ies) of/i);
    const tiers = report.sections.find((section) => section.kind === "text" && section.title === "GNN tiers");
    expect(tiers && tiers.kind === "text" ? tiers.body : "").toContain("high:");
  });

  it("drops the GNN accuracy figures for a model other than the measured release", () => {
    const other: NmrPredictionResult = {
      ...gnnResult,
      backend: { ...gnnResult.backend, model: { ...gnnResult.backend.model!, version: "retrained" } }
    };
    expect(sectionsJson(composePredictionReport(source, other))).not.toContain("Measured MAE");
  });

  it("keeps the HOSE-only layout for results without method labels", () => {
    const legacy: NmrPredictionResult = {
      ...gnnResult,
      backend: { id: "chemdraft.ocl-hose", version: "1", method: "hose-fragment" },
      resonances: [{ ...gnnResult.resonances[2], method: undefined, modelDeclines: undefined }]
    };
    const table = composePredictionReport(source, legacy).sections.find((section) => section.kind === "table");
    expect(table && table.kind === "table" ? table.columns : []).not.toContain("Method");
  });
});
