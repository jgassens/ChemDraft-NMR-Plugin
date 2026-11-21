import { PluginPanelReportSchema, type PluginSelectedMolecule } from "@chemdraft/plugin-api";
import * as OCL from "openchemlib";
import { describe, expect, it } from "vitest";

import type { NmrPredictionResult, NmrResonance, NmrStructureAtom } from "../domain/contracts";
import { NmrPredictionResultSchema } from "../domain/schemas";
import type { CompiledNmrDatabase } from "../providers/ocl/localDatabase";
import { OclHosePredictor } from "../providers/ocl/OclHosePredictor";
import { buildStructureDepiction } from "../providers/ocl/structureDepiction";
import { composePredictionReport, depictionAtomLabel } from "../report/composePredictionReport";

const source: PluginSelectedMolecule = {
  objectId: "m1",
  documentId: "doc1",
  pageId: "p1",
  structureFormat: "smiles",
  structure: "[O-][n+]1ccccc1",
  sourceFingerprint: "fp1"
};

const EMPTY_DATABASE: CompiledNmrDatabase = {
  provenance: {
    name: "test",
    version: "1",
    source: "s",
    license: "l",
    attribution: "a",
    note: "n",
    structureCount: 0,
    entryCount: 0,
    nuclei: ["1H", "13C"],
    generatedAt: "t"
  },
  entries: {}
};

const resonance: NmrResonance = {
  id: "c-0",
  nucleus: "13C",
  deltaPpm: 139.0,
  atomRefs: [{ sourceAtomIndex: 2, element: "C", equivalentCount: 1 }],
  equivalentNuclei: 2,
  evidence: { method: "hose-fragment", matchedSphere: 3, sampleCount: 12 },
  flags: []
};

function hoseResult(overrides: Partial<NmrPredictionResult> = {}): NmrPredictionResult {
  return {
    schemaVersion: "1",
    sourceFingerprint: "fp1",
    backend: { id: "chemdraft.ocl-hose", version: "1", method: "hose-fragment" },
    resonances: [resonance],
    warnings: [],
    generatedAt: "t",
    ...overrides
  };
}

function figureOf(result: NmrPredictionResult) {
  const report = composePredictionReport(source, result);
  expect(PluginPanelReportSchema.safeParse(report).success).toBe(true);
  const figure = report.sections.find((section) => section.kind === "linkedFigure");
  if (!figure || figure.kind !== "linkedFigure") throw new Error("expected a linkedFigure section");
  return figure;
}

describe("structure drawing keeps charge, radical and isotope marks", () => {
  it("draws pyridine N-oxide with N+ and O− from the predictor's own depiction", async () => {
    const predicted = await new OclHosePredictor({ database: EMPTY_DATABASE }).predict({
      structure: { format: "smiles", value: "[O-][n+]1ccccc1" },
      nuclei: ["13C"],
      options: { statistic: "median", hoseLevels: [4, 3, 2, 1], ignoreLabileHydrogens: true }
    });
    // The worker boundary must not strip the charge either.
    const parsed = NmrPredictionResultSchema.parse(JSON.parse(JSON.stringify(predicted))) as NmrPredictionResult;
    const depicted = parsed.depiction?.atoms ?? [];
    expect(depicted.filter((atom) => atom.charge !== undefined).map((atom) => [atom.element, atom.charge]).sort())
      .toEqual([["N", 1], ["O", -1]]);

    const figure = figureOf(hoseResult({ depiction: parsed.depiction }));
    const labels = (figure.structure?.atoms ?? []).map((atom) => atom.element);
    expect(labels).toContain("N+");
    expect(labels).toContain("O−");
    expect(labels).not.toContain("N");
    expect(labels).not.toContain("O");
    expect(figure.caption).not.toContain("Structure drawing omitted");
  });

  it("carries radicals and isotope labels from OpenChemLib into the drawing", () => {
    const molecule = OCL.Molecule.fromSmiles("CC");
    molecule.setAtomRadical(1, OCL.Molecule.cAtomRadicalStateD);
    const doublet = buildStructureDepiction(molecule);
    expect(doublet?.atoms[1].radical).toBe("doublet");
    expect(figureOf(hoseResult({ depiction: doublet })).structure?.atoms.map((atom) => atom.element)).toEqual(["C", "C•"]);

    const isotope = buildStructureDepiction(OCL.Molecule.fromSmiles("[13CH4]"));
    expect(isotope?.atoms[0].isotopeMass).toBe(13);
    const labels = figureOf(hoseResult({ depiction: isotope })).structure?.atoms.map((atom) => atom.element);
    expect(labels).toEqual(["13C"]);

    const deuterium = buildStructureDepiction(OCL.Molecule.fromSmiles("[2H]C"));
    expect(deuterium?.atoms.find((atom) => atom.element === "D")?.isotopeMass).toBeUndefined();
  });

  it.each([
    [{ element: "N", charge: 1 }, "N+"],
    [{ element: "O", charge: -1 }, "O−"],
    [{ element: "Fe", charge: 2 }, "Fe2+"],
    [{ element: "S", charge: -2 }, "S2−"],
    [{ element: "C", radical: "doublet" }, "C•"],
    [{ element: "C", radical: "triplet" }, "C••"],
    [{ element: "N", radical: "doublet", charge: 1 }, "N•+"],
    [{ element: "C", isotopeMass: 13 }, "13C"],
    [{ element: "C" }, "C"],
    [{ element: "D" }, "D"]
  ] as const)("labels %o as %s", (features, label) => {
    expect(depictionAtomLabel({ index: 0, x: 0, y: 0, ...features } as NmrStructureAtom)).toBe(label);
  });

  it("omits the drawing with a notice when an atom state has no faithful mark", () => {
    const figure = figureOf(hoseResult({
      depiction: {
        atoms: [
          { index: 0, x: 0, y: 0, element: "C", radical: "singlet" },
          { index: 1, x: 1, y: 0, element: "O", charge: -1 }
        ],
        bonds: [{ from: 0, to: 1, order: 1 }]
      }
    }));
    expect(figure.structure).toBeUndefined();
    expect(figure.caption).toContain("Structure drawing omitted");
  });
});

describe("report Method field never shows a raw backend id", () => {
  const rawIds = ["hose-fragment", "fixture-fragment", "gnn", "dft", "hybrid"];

  function methodValue(result: NmrPredictionResult): string {
    const report = composePredictionReport(source, result);
    const prediction = report.sections.find((section) => section.kind === "keyValue" && section.title === "Prediction");
    if (!prediction || prediction.kind !== "keyValue") throw new Error("expected the Prediction section");
    const row = prediction.rows.find((entry) => entry.label === "Method");
    if (!row) throw new Error("expected a Method row");
    return row.value;
  }

  it("names a HOSE-only result 'HOSE lookup' (e.g. 31P, or the GNN unavailable)", () => {
    expect(methodValue(hoseResult())).toBe("HOSE lookup");
    expect(methodValue(hoseResult({
      resonances: [{ ...resonance, nucleus: "31P", atomRefs: [{ sourceAtomIndex: 0, element: "P", equivalentCount: 1 }] }]
    }))).toBe("HOSE lookup");
    // A GNN-backend result whose atoms all fell back to the lookup.
    expect(methodValue(hoseResult({
      backend: { id: "chemdraft.gnn-hose", version: "1", method: "gnn" },
      resonances: [{ ...resonance, method: "HOSE lookup", source: "lookup" }]
    }))).toBe("HOSE lookup");
  });

  it("names the HOSE and rule-estimate mix without the raw id", () => {
    const mixed = hoseResult({
      resonances: [
        resonance,
        {
          ...resonance,
          id: "est",
          deltaPpm: 20,
          evidence: { method: "rule-estimated", estimator: { id: "rules", version: "1", method: "generic" } },
          flags: ["rule-estimated"]
        }
      ]
    });
    expect(methodValue(mixed)).toBe("HOSE lookup + rule-estimated");
  });

  it.each([
    ["hose-fragment", "HOSE lookup"],
    ["fixture-fragment", "synthetic fixture"],
    ["gnn", "GNN prediction"],
    ["dft", "DFT calculation"],
    ["hybrid", "hybrid method"],
    ["some-new-backend", "predicted (other method)"]
  ])("maps backend method %s with no labeled resonances to %s", (method, name) => {
    const value = methodValue(hoseResult({
      backend: { id: "x", version: "1", method },
      resonances: [{ ...resonance, evidence: undefined }]
    }));
    expect(value).toBe(name);
    expect(rawIds.filter((id) => id.includes("-")).some((id) => value.includes(id))).toBe(false);
  });
});

describe("tier words are the same full words in every path", () => {
  function confidenceColumn(result: NmrPredictionResult): string[] {
    const report = composePredictionReport(source, result);
    const table = report.sections.find((section) => section.kind === "table");
    if (!table || table.kind !== "table") throw new Error("expected a table section");
    const column = table.columns.indexOf("Confidence");
    return table.rows.map((row) => row[column]);
  }

  const mediumHose: NmrResonance = {
    ...resonance,
    nucleus: "1H",
    atomRefs: [{ sourceAtomIndex: 0, element: "H", equivalentCount: 1 }],
    evidence: { method: "hose-fragment", matchedSphere: 2, sampleCount: 5 }
  };

  it("HOSE fallback for 1H in a GNN result says 'medium', never 'med'", () => {
    const cells = confidenceColumn(hoseResult({
      backend: { id: "chemdraft.gnn-hose", version: "1", method: "gnn" },
      resonances: [
        { ...mediumHose, id: "g", deltaPpm: 7.3, method: "GNN prediction", source: "model", tier: "medium", evidence: { method: "gnn" } },
        { ...mediumHose, method: "HOSE lookup", source: "lookup", modelDeclines: ["element"] }
      ]
    }));
    expect(cells[0].split(" · ")[0]).toBe("medium");
    expect(cells[1].split(" · ")[0]).toBe("medium");
  });

  it("HOSE-only 1H and 31P results say 'medium', never 'med'", () => {
    const proton = confidenceColumn(hoseResult({ resonances: [mediumHose] }));
    const phosphorus = confidenceColumn(hoseResult({
      resonances: [{ ...mediumHose, nucleus: "31P", atomRefs: [{ sourceAtomIndex: 0, element: "P", equivalentCount: 1 }] }]
    }));
    for (const cell of [...proton, ...phosphorus]) {
      expect(cell.split(" · ")[0]).toBe("medium");
      expect(cell).not.toMatch(/\bmed\b/);
    }
  });
});
