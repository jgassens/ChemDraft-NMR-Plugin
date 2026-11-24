// @vitest-environment node
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type {
  PluginAnalysisRecordInput,
  PluginCommandContext,
  PluginPanelReport,
  PluginSelectedMolecule
} from "@chemdraft/plugin-api";
import { PluginPanelReportSchema } from "@chemdraft/plugin-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEUTERIUM_PROTON_GYROMAGNETIC_RATIO } from "../domain/firstOrderCoupling";
import type { NmrPredictionResult, NmrResonance } from "../domain/contracts";
import { NmrWarningCodes } from "../domain/warnings";
import { nmrPredictProtonCommandId } from "../manifest";
import { GnnShiftPredictor } from "../providers/gnn/GnnShiftPredictor";
import { GnnModelRuntime } from "../providers/gnn/runtime";
import { createNmrCommandHandlers } from "../register";

/**
 * Release gate for the labels the report must carry. It drives the REAL command path
 * (registered ¹H command handler → predictSelectedStructure → GnnShiftPredictor → composePredictionReport
 * → the panel report the host hands to PluginReportRenderer) for deuterated structures, then walks the
 * composed report structurally:
 *   1. every H–D mention carries the first-order-estimate wording the plugin itself uses;
 *   2. every ¹H shift row names its method (GNN prediction / HOSE lookup) and a tier (high / medium /
 *      low), never a percentage.
 * It runs once with the real bundled ONNX model and once with the model forced unavailable (the HOSE
 * fallback, forced the way f19Prediction.test.ts does it: a runtime whose asset fetch fails).
 */

// ONNX Runtime Web's Node loader sets `global.Worker`; undo it so other test files are unaffected.
const hadWorker = "Worker" in globalThis;
const previousWorker = (globalThis as { Worker?: unknown }).Worker;
afterAll(() => {
  if (hadWorker) (globalThis as { Worker?: unknown }).Worker = previousWorker;
  else delete (globalThis as { Worker?: unknown }).Worker;
});

const readAsset = async (url: URL): Promise<Uint8Array> => new Uint8Array(await readFile(url));
const missingAsset = async (): Promise<Uint8Array> => {
  throw new Error("HTTP 404");
};

// ---------------------------------------------------------------------------------------------
// The wording, taken from the plugin's own source (not re-typed here). composePredictionReport.ts
// builds these strings inline; the gate extracts them so a reworded or dropped label fails the gate
// at extraction instead of silently relaxing it.
// ---------------------------------------------------------------------------------------------
const reportSource = readFileSync(new URL("../report/composePredictionReport.ts", import.meta.url), "utf8");
function sourceString(pattern: RegExp, what: string): string {
  const match = reportSource.match(pattern);
  if (!match) throw new Error(`release gate: cannot find ${what} in src/report/composePredictionReport.ts`);
  return match[0];
}
/** "typical first-order estimates" — the legend, caption and notice sentence. */
const ESTIMATE_PHRASE = sourceString(/typical first-order estimate/, "the first-order-estimate sentence");
/** "H–D est." — the inline label on multiplet descriptions, labels and J lists. */
const ESTIMATE_SHORT_LABEL = sourceString(/H–D est\./, "the inline H–D estimate label");
/** The scaled-constant statement: the source builds it from this exported constant. */
const J_HD_STATEMENT = `J(HD) = ${DEUTERIUM_PROTON_GYROMAGNETIC_RATIO.toFixed(4)} × J(HH)`;
const ALLOWED_TIERS = ["high", "medium", "low"] as const;
const ALLOWED_METHODS = ["GNN prediction", "HOSE lookup"] as const;

/** Anything that names an H–D coupling. */
const HD_MENTION = /H[–-]D|J\(HD\)|¹H[–-]²H|\bHD\b/;
const KNOWN_SECTION_KINDS = new Set(["keyValue", "linkedFigure", "table", "text"]);

// ---------------------------------------------------------------------------------------------
// Structural walk
// ---------------------------------------------------------------------------------------------
interface Leaf {
  path: string;
  text: string;
}

/** Every string anywhere under a value, with its path. Cannot miss a new field or section. */
function leaves(value: unknown, path: string, out: Leaf[] = []): Leaf[] {
  if (typeof value === "string") out.push({ path, text: value });
  else if (Array.isArray(value)) value.forEach((item, index) => leaves(item, `${path}[${index}]`, out));
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) leaves(item, `${path}.${key}`, out);
  }
  return out;
}

type Section = PluginPanelReport["sections"][number];
const sectionName = (section: Section, index: number): string =>
  `section #${index} (${section.kind}${"title" in section && section.title ? `: "${section.title}"` : ""})`;

function reportLeaves(report: PluginPanelReport): (Leaf & { section: string })[] {
  return report.sections.flatMap((section, index) => {
    const name = sectionName(section, index);
    return leaves(section, name).map((leaf) => ({ ...leaf, section: name }));
  });
}

const carriesEstimateWording = (text: string): boolean =>
  text.includes(ESTIMATE_PHRASE) || text.includes(ESTIMATE_SHORT_LABEL);

/** Problems with (1): H–D mentions lacking the estimate wording. */
function hdWordingProblems(report: PluginPanelReport, result: NmrPredictionResult): string[] {
  const problems: string[] = [];
  const all = reportLeaves(report);
  for (const leaf of all) {
    // A section heading ("H–D coupling legend") only names the section; its own text must carry the wording.
    const isTitle = /\.title$/.test(leaf.path);
    const covered = isTitle
      ? all.some((other) => other.section === leaf.section && other.path !== leaf.path && carriesEstimateWording(other.text))
      : carriesEstimateWording(leaf.text);
    if (HD_MENTION.test(leaf.text) && !covered) {
      problems.push(`${leaf.path}: H–D mention without the first-order-estimate wording: ${JSON.stringify(leaf.text.slice(0, 160))}`);
    }
    if (leaf.text.includes("J(HD)") && !leaf.text.includes(J_HD_STATEMENT)) {
      problems.push(`${leaf.path}: J(HD) is not stated as "${J_HD_STATEMENT}"`);
    }
  }

  // Presence: a structure whose result really has H–D couplings must show them with the wording in
  // the places the user reads them. (The walk above cannot catch a multiplet line with an empty label.)
  const hasCoupling = result.resonances.some((r: NmrResonance) =>
    r.multiplet?.couplings.some((c) => c.partnerNucleus === "2H"));
  if (hasCoupling) {
    report.sections.forEach((section, index) => {
      const name = sectionName(section, index);
      if (section.kind === "linkedFigure" && !section.caption?.includes(ESTIMATE_PHRASE)) {
        problems.push(`${name}: figure caption lacks "${ESTIMATE_PHRASE}" although the result has H–D couplings`);
      }
      if (section.kind === "table") {
        const cells = section.rows.flat().join(" | ");
        if (!cells.includes(ESTIMATE_SHORT_LABEL)) problems.push(`${name}: no table cell carries "${ESTIMATE_SHORT_LABEL}" although the result has H–D couplings`);
      }
    });
    if (!all.some((leaf) => leaf.text.includes(ESTIMATE_PHRASE) && leaf.text.includes(J_HD_STATEMENT))) {
      problems.push(`no section states "${J_HD_STATEMENT}" with "${ESTIMATE_PHRASE}"`);
    }
  }
  return problems;
}

/** Problems with (2): method and tier on every ¹H shift row; no percentage tier anywhere. */
function methodAndTierProblems(report: PluginPanelReport): string[] {
  const problems: string[] = [];
  let protonRows = 0;
  report.sections.forEach((section, index) => {
    const name = sectionName(section, index);
    if (!KNOWN_SECTION_KINDS.has(section.kind)) {
      problems.push(`${name}: unknown section kind "${section.kind}" — extend the release gate to cover it`);
      return;
    }
    if (section.kind === "linkedFigure") {
      section.spectrum.peaks.forEach((peak) => {
        if (peak.confidence !== undefined && !(ALLOWED_TIERS as readonly string[]).includes(peak.confidence)) {
          problems.push(`${name}: peak ${peak.id} confidence "${peak.confidence}" is not one of ${ALLOWED_TIERS.join("/")}`);
        }
      });
    }
    if (section.kind !== "table") return;
    const method = section.columns.indexOf("Method");
    const confidence = section.columns.indexOf("Confidence");
    const nucleus = section.columns.indexOf("Nucleus");
    if (nucleus < 0) {
      if (section.columns.some((column) => column.startsWith("δ"))) problems.push(`${name}: shift table without a Nucleus column`);
      return;
    }
    section.rows.forEach((row, rowIndex) => {
      if (!row[nucleus]?.startsWith("¹H")) return;
      protonRows += 1;
      const where = `${name} row ${rowIndex} (δ ${row[section.columns.findIndex((c) => c.startsWith("δ"))]})`;
      if (method < 0) problems.push(`${where}: table has no Method column`);
      else if (!(ALLOWED_METHODS as readonly string[]).includes(row[method])) {
        problems.push(`${where}: method "${row[method]}" is not ${ALLOWED_METHODS.join(" or ")}`);
      }
      if (confidence < 0) problems.push(`${where}: table has no Confidence (tier) column`);
      else {
        const cell = row[confidence];
        const tier = cell.match(/^(\w+)/)?.[1];
        if (!tier || !(ALLOWED_TIERS as readonly string[]).includes(tier)) {
          problems.push(`${where}: tier cell ${JSON.stringify(cell)} does not start with ${ALLOWED_TIERS.join("/")}`);
        }
        if (/%/.test(cell)) problems.push(`${where}: tier cell ${JSON.stringify(cell)} shows a percentage`);
      }
    });
  });
  if (protonRows === 0) problems.push("the report has no ¹H shift row at all");

  // A tier is never shown as a percentage, wherever it appears in the report.
  for (const leaf of reportLeaves(report)) {
    if (/\b(?:high|medium|low)\b[^.\n|]{0,24}?\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*%[^.\n|]{0,24}?\b(?:high|medium|low|confidence)\b|\bconfidence\b[^.\n|]{0,24}?\d+(?:\.\d+)?\s*%/i.test(leaf.text)) {
      problems.push(`${leaf.path}: a tier/confidence is shown as a percentage: ${JSON.stringify(leaf.text.slice(0, 160))}`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// The real command path
// ---------------------------------------------------------------------------------------------
function makeContext(molecule: PluginSelectedMolecule) {
  const reports: PluginPanelReport[] = [];
  const writes: PluginAnalysisRecordInput[] = [];
  const context = {
    plugin: { id: "org.chemdraft.nmr.predictor", name: "NMR", version: "0", permissions: [] },
    documents: {},
    selection: { getSelection: async () => ({ objectIds: [molecule.objectId], molecules: [molecule] }) },
    analysis: {
      write: async (input: PluginAnalysisRecordInput) => {
        writes.push(input);
        return { ...input, id: "rec", pluginId: "org.chemdraft.nmr.predictor", createdAt: "t" } as never;
      },
      list: async () => [],
      getLatest: async () => undefined
    },
    panels: { showReport: async (_panelId: string, report: PluginPanelReport) => void reports.push(report) },
    hasPermission: () => true,
    requirePermission: () => undefined
  } as unknown as PluginCommandContext;
  return { context, reports, writes };
}

async function runProtonCommand(smiles: string, fetchAsset: (url: URL) => Promise<Uint8Array>) {
  const molecule: PluginSelectedMolecule = {
    objectId: "m1",
    documentId: "doc1",
    pageId: "p1",
    structureFormat: "smiles",
    structure: smiles,
    sourceFingerprint: `fp-${smiles}`
  };
  const predictor = new GnnShiftPredictor({ models: new GnnModelRuntime({ fetchAsset }), now: () => "t" });
  const handlers = createNmrCommandHandlers({ predictor });
  const { context, reports, writes } = makeContext(molecule);
  const outcome = await handlers[nmrPredictProtonCommandId](context);
  expect(outcome, `command failed for ${smiles}`).toMatchObject({ ok: true });
  // The command first shows a pending report, then the composed one: the gate checks the last.
  expect(reports.length).toBeGreaterThanOrEqual(1);
  expect(writes).toHaveLength(1);
  return { report: reports[reports.length - 1], result: writes[0].payload as NmrPredictionResult };
}

const STRUCTURES = [
  { name: "ethanol-1-d1", smiles: "[2H]C(C)O" },
  { name: "benzene-d5 (C6D5H)", smiles: "[2H]c1c([2H])c([2H])c([2H])c([2H])c1" },
  { name: "CH2D-CH3", smiles: "[2H]CC" }
] as const;

const PATHS = [
  { name: "GNN (bundled ONNX model)", fetchAsset: readAsset, method: "GNN prediction" },
  { name: "HOSE fallback (model unavailable)", fetchAsset: missingAsset, method: "HOSE lookup" }
] as const;

describe("release label gate: the source wording the gate checks against", () => {
  it("was extracted from the plugin source", () => {
    expect(ESTIMATE_PHRASE).toBe("typical first-order estimate");
    expect(ESTIMATE_SHORT_LABEL).toBe("H–D est.");
    expect(J_HD_STATEMENT).toContain("0.1535");
    // The legend that states J(HD) must be built from the same constant and sentence.
    expect(reportSource).toContain("DEUTERIUM_PROTON_GYROMAGNETIC_RATIO.toFixed(4)");
  });
});

describe("release label gate: composed ¹H report for deuterated structures", () => {
  for (const path of PATHS) {
    describe(path.name, () => {
      for (const structure of STRUCTURES) {
        describe(structure.name, () => {
          let composed: Awaited<ReturnType<typeof runProtonCommand>>;
          beforeAll(async () => {
            composed = await runProtonCommand(structure.smiles, path.fetchAsset);
          }, 120_000);

          it("is a valid panel report from the intended prediction path", () => {
            expect(PluginPanelReportSchema.safeParse(composed.report).success).toBe(true);
            const resonances = composed.result.resonances.filter((r) => r.nucleus === "1H");
            expect(resonances.length).toBeGreaterThan(0);
            // The path under test really ran: every shown shift has the path's method.
            expect(resonances.map((r) => r.method)).toEqual(resonances.map(() => path.method));
            const unavailable = composed.result.warnings.some((w) => w.code === NmrWarningCodes.GnnModelUnavailable);
            expect(unavailable).toBe(path.method === "HOSE lookup");
            // The structure really has an H–D coupling for the gate to bite on.
            expect(resonances.some((r) => r.multiplet?.couplings.some((c) => c.partnerNucleus === "2H"))).toBe(true);
          });

          it("labels every H–D coupling with the first-order-estimate wording", () => {
            expect(hdWordingProblems(composed.report, composed.result), "H–D wording problems").toEqual([]);
          });

          it("gives every ¹H shift row a method and a high/medium/low tier, never a percentage", () => {
            expect(methodAndTierProblems(composed.report), "method/tier problems").toEqual([]);
          });
        });
      }
    });
  }
});

describe("release label gate: the checks themselves bite", () => {
  const base: PluginPanelReport = {
    title: "t",
    sections: [
      { kind: "text", title: "Legend", body: "¹H–²H couplings are typical first-order estimates: J(HD) = 0.1535 × J(HH)." },
      { kind: "table", title: "Predicted shifts", columns: ["Nucleus", "δ (ppm)", "Method", "Confidence"], rows: [["¹H", "1.20", "GNN prediction", "high · s4, n=7"]] }
    ]
  } as PluginPanelReport;
  const noResult = { resonances: [] } as unknown as NmrPredictionResult;

  it("accepts a labelled report", () => {
    expect(hdWordingProblems(base, noResult)).toEqual([]);
    expect(methodAndTierProblems(base)).toEqual([]);
  });

  it("names the section of an unlabelled H–D mention", () => {
    const report = { ...base, sections: [...base.sections, { kind: "text", title: "Extra", body: "H–D coupling 1.1 Hz" }] } as PluginPanelReport;
    expect(hdWordingProblems(report, noResult).join("\n")).toMatch(/section #2 \(text: "Extra"\).*H–D mention without/);
  });

  it("rejects a missing method, an est. tier, and a percentage tier", () => {
    const table = (row: string[]) => ({ ...base, sections: [{ kind: "table", title: "S", columns: ["Nucleus", "δ (ppm)", "Method", "Confidence"], rows: [row] }] }) as PluginPanelReport;
    expect(methodAndTierProblems(table(["¹H", "1.2", "—", "high"])).join()).toMatch(/method "—"/);
    expect(methodAndTierProblems(table(["¹H", "1.2", "HOSE lookup", "est."])).join()).toMatch(/tier cell/);
    expect(methodAndTierProblems(table(["¹H", "1.2", "HOSE lookup", "high 90%"])).join()).toMatch(/percentage/);
  });

  it("rejects a section kind it does not know", () => {
    const report = { ...base, sections: [{ kind: "chart", title: "x" }] } as unknown as PluginPanelReport;
    expect(methodAndTierProblems(report).join()).toMatch(/unknown section kind/);
  });
});
