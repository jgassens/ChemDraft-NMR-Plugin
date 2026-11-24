// @vitest-environment node
import { readFile } from "node:fs/promises";
import type {
  PluginAnalysisRecordInput,
  PluginCommandContext,
  PluginPanelReport,
  PluginSelectedMolecule
} from "@chemdraft/plugin-api";
import { PluginPanelReportSchema } from "@chemdraft/plugin-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isRuleEstimated } from "../domain/contracts";
import type { NmrPredictionResult, NmrResonance } from "../domain/contracts";
import { DEUTERIUM_PROTON_GYROMAGNETIC_RATIO } from "../domain/firstOrderCoupling";
import { NmrWarningCodes } from "../domain/warnings";
import { nmrPredictProtonCommandId } from "../manifest";
import { GnnShiftPredictor } from "../providers/gnn/GnnShiftPredictor";
import { GnnModelRuntime } from "../providers/gnn/runtime";
import { createNmrCommandHandlers } from "../register";
import { composePendingReport } from "../report/composePredictionReport";
import { hasDeuteriumCoupling } from "../report/deuteriumMultiplet";
import {
  FIRST_ORDER_ESTIMATE_PHRASE,
  HD_ESTIMATE_CAPTION_SENTENCE,
  HD_ESTIMATE_LABEL,
  HD_SVG_FOOTER_PREFIX,
  HH_ESTIMATE_CAPTION_SENTENCE,
  RULE_ESTIMATE_MARKER
} from "../report/labels";
import { renderStickSpectrumSvg } from "../report/stickSpectrumSvg";

/**
 * Release gate for the labels the report must carry. It drives the REAL command path
 * (registered ¹H command handler → predictSelectedStructure → GnnShiftPredictor → composePredictionReport
 * → the panel report the host hands to PluginReportRenderer) for deuterated structures, then walks the
 * composed report structurally:
 *   1. every H–D coupling value or pattern carries the first-order-estimate wording the plugin itself
 *      uses (imported from src/report/labels.ts); omission notices ("H–D coupling not shown for …")
 *      state no coupling value and need no estimate wording;
 *   2. per resonance: the J cell holds one H–D estimate marker per ²H coupling, the spectrum peak
 *      labels of every H–D-coupled resonance carry the H–D estimate label, the caption carries the
 *      H–D estimate sentence, and the exported stick-spectrum SVG labels carry the marker;
 *   3. every ¹H shift row names its method (GNN prediction / HOSE lookup) and a tier: high / medium /
 *      low for GNN and HOSE-lookup rows, or the documented rule-estimate marker "est." (docs/gnn-model.md)
 *      for rule-estimated rows only, which must also be visibly labeled as rule estimates; never a
 *      percentage;
 *   4. the pending report never shows an H–D value without the marker.
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
// The wording comes from the plugin's own exports (src/report/labels.ts), not re-typed here.
// ---------------------------------------------------------------------------------------------
const ESTIMATE_PHRASE = FIRST_ORDER_ESTIMATE_PHRASE;
const ESTIMATE_SHORT_LABEL = HD_ESTIMATE_LABEL;
/** The scaled-constant statement: the source builds it from this exported constant. */
const J_HD_STATEMENT = `J(HD) = ${DEUTERIUM_PROTON_GYROMAGNETIC_RATIO.toFixed(4)} × J(HH)`;
const ALLOWED_TIERS = ["high", "medium", "low"] as const;
const ALLOWED_METHODS = ["GNN prediction", "HOSE lookup"] as const;

/** Anything that names an H–D coupling. */
const HD_MENTION = /H[–-]D|J\(HD\)|¹H[–-]²H|\bHD\b/;
/** An omission notice names the protons whose H–D coupling is left out; it states no coupling value. */
const HD_OMISSION_NOTICE = /^(?:Long-range )?H–D coupling not shown for proton host atoms [\d, ]+ \(zero-based\)/;
const HZ_VALUE = /\d+(?:\.\d+)?\s*Hz\b/;
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
    if (HD_OMISSION_NOTICE.test(leaf.text) && !HZ_VALUE.test(leaf.text)) continue;
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
      if (section.kind === "linkedFigure" && !section.caption?.includes(HD_ESTIMATE_CAPTION_SENTENCE)) {
        problems.push(`${name}: figure caption lacks the H–D estimate sentence ${JSON.stringify(HD_ESTIMATE_CAPTION_SENTENCE.trim().slice(0, 60))}… although the result has H–D couplings (the ¹H–¹H sentence "${HH_ESTIMATE_CAPTION_SENTENCE.trim()}" does not cover them)`);
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

const hdCouplingCount = (resonance: NmrResonance): number =>
  resonance.multiplet?.couplings.filter((coupling) => coupling.partnerNucleus === "2H").length ?? 0;
const countOccurrences = (text: string, needle: string): number => text.split(needle).length - 1;
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const atomsKey = (resonance: NmrResonance): string => resonance.atomRefs.map((ref) => ref.sourceAtomIndex).join(", ");

/** Problems with (2), report side: each H–D-coupled resonance is marked in its J cell and on its peak labels. */
function perResonanceProblems(report: PluginPanelReport, result: NmrPredictionResult): string[] {
  const problems: string[] = [];
  const protons = result.resonances.filter((resonance) => resonance.nucleus === "1H");
  const tables = report.sections.filter((section) => section.kind === "table" && section.columns.includes("J est. (Hz)"));
  const figures = report.sections.filter((section) => section.kind === "linkedFigure");
  if (tables.length !== 1) problems.push(`expected one shift table with a "J est. (Hz)" column, found ${tables.length}`);
  if (figures.length < 1) problems.push("the report has no linked spectrum figure");
  for (const resonance of protons) {
    const expected = hdCouplingCount(resonance);
    const where = `resonance ${resonance.id} (δ ${resonance.deltaPpm.toFixed(2)}, atoms ${atomsKey(resonance)})`;
    // J cell: one H–D marker per ²H coupling, found by the resonance's atoms cell.
    for (const table of tables) {
      if (table.kind !== "table") continue;
      const nucleus = table.columns.indexOf("Nucleus");
      const jColumn = table.columns.indexOf("J est. (Hz)");
      const atoms = table.columns.indexOf("Atoms");
      const rows = table.rows.filter((row) => row[nucleus]?.startsWith("¹H") && row[atoms] === atomsKey(resonance));
      if (rows.length !== 1) {
        problems.push(`${where}: expected exactly one table row, found ${rows.length}`);
        continue;
      }
      const cell = rows[0][jColumn];
      const markers = countOccurrences(cell, ESTIMATE_SHORT_LABEL);
      if (markers !== expected) {
        problems.push(`${where}: J cell ${JSON.stringify(cell)} has ${markers} "${ESTIMATE_SHORT_LABEL}" marker(s) for ${expected} ²H coupling(s)`);
      }
      const values = cell === "—" ? [] : cell.split(", ");
      if (values.length !== (resonance.multiplet?.couplings.length ?? 0)) {
        problems.push(`${where}: J cell ${JSON.stringify(cell)} lists ${values.length} value(s) for ${resonance.multiplet?.couplings.length ?? 0} coupling(s)`);
      }
    }
    if (expected === 0) continue;
    // Spectrum peaks of an H–D-coupled resonance: its multiplet label carries the H–D estimate label.
    for (const figure of figures) {
      if (figure.kind !== "linkedFigure") continue;
      const own = new RegExp(`^${escapeRegExp(resonance.id)}-line-\\d+$`);
      const peaks = figure.spectrum.peaks.filter((peak) => own.test(peak.id));
      if (peaks.length === 0) {
        problems.push(`${where}: no H–D multiplet peaks in the figure`);
      } else if (!peaks.some((peak) => peak.label?.includes(`; ${ESTIMATE_SHORT_LABEL})`))) {
        problems.push(`${where}: no peak label carries "${ESTIMATE_SHORT_LABEL}": ${JSON.stringify(peaks.map((peak) => peak.label))}`);
      }
    }
  }
  return problems;
}

/** Problems with (2), export side: every H–D label in the exported stick-spectrum SVG carries the marker. */
function svgProblems(result: NmrPredictionResult, svg: string = renderStickSpectrumSvg(result)): string[] {
  const problems: string[] = [];
  const texts = [...svg.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map((match) => match[1]);
  const hdTexts = texts.filter((text) => HD_MENTION.test(text));
  for (const text of hdTexts) {
    if (!text.includes(ESTIMATE_SHORT_LABEL) && !text.includes(HD_SVG_FOOTER_PREFIX)) {
      problems.push(`SVG H–D label without the estimate marker: ${JSON.stringify(text)}`);
    }
  }
  const coupled = result.resonances.filter(hasDeuteriumCoupling);
  if (coupled.length === 0) return problems;
  if (!texts.some((text) => text.startsWith(HD_SVG_FOOTER_PREFIX))) {
    problems.push(`SVG lacks the footer "${HD_SVG_FOOTER_PREFIX.trim()}"`);
  }
  for (const resonance of coupled) {
    const label = texts.find((text) => text.startsWith(resonance.deltaPpm.toFixed(1)) && text.includes(`(${resonance.multiplet?.label};`));
    if (!label) problems.push(`SVG has no multiplet label for resonance ${resonance.id} (δ ${resonance.deltaPpm.toFixed(1)})`);
    else if (!label.endsWith(`; ${ESTIMATE_SHORT_LABEL})`)) problems.push(`SVG label ${JSON.stringify(label)} lacks "${ESTIMATE_SHORT_LABEL}"`);
  }
  if (hdTexts.filter((text) => text.includes(ESTIMATE_SHORT_LABEL)).length !== coupled.length) {
    problems.push(`SVG has ${hdTexts.filter((text) => text.includes(ESTIMATE_SHORT_LABEL)).length} H–D multiplet label(s) for ${coupled.length} H–D-coupled resonance(s)`);
  }
  return problems;
}

/** Problems with (4): the pending report names no H–D value, and no H–D mention without the wording. */
function pendingProblems(report: PluginPanelReport): string[] {
  const problems = hdWordingProblems(report, { resonances: [] } as unknown as NmrPredictionResult);
  for (const leaf of reportLeaves(report)) {
    if (HZ_VALUE.test(leaf.text) && !leaf.text.includes(ESTIMATE_SHORT_LABEL)) {
      problems.push(`${leaf.path}: pending report shows a coupling value without the marker: ${JSON.stringify(leaf.text.slice(0, 160))}`);
    }
  }
  return problems;
}

/** Problems with (3): method and tier on every ¹H shift row (high/medium/low, or "est." for rule-estimated rows only); no percentage tier anywhere. */
function methodAndTierProblems(report: PluginPanelReport, result: NmrPredictionResult): string[] {
  const problems: string[] = [];
  const ruleEstimatedAtoms = new Set(result.resonances.filter(isRuleEstimated).map(atomsKey));
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
      const atoms = section.columns.indexOf("Atoms");
      const isRule = ruleEstimatedAtoms.has(row[atoms]);
      if (confidence < 0) problems.push(`${where}: table has no Confidence (tier) column`);
      else {
        const cell = row[confidence];
        const tier = cell.match(/^(\w+)/)?.[1];
        if (isRule) {
          // A rule-estimated row is never a database or GNN tier: it carries the documented "est." marker
          // (docs/gnn-model.md) and is visibly labeled a rule estimate in its other cells.
          if (!cell.startsWith(RULE_ESTIMATE_MARKER)) {
            problems.push(`${where}: rule-estimated row's tier cell ${JSON.stringify(cell)} does not start with "${RULE_ESTIMATE_MARKER}"`);
          }
          if (!row[section.columns.findIndex((c) => c.startsWith("δ"))].startsWith("≈")) problems.push(`${where}: rule-estimated row's δ is not marked "≈"`);
          if (!row[section.columns.indexOf("Environment")]?.startsWith("rule-estimated")) problems.push(`${where}: rule-estimated row's environment does not say "rule-estimated"`);
        } else if (!tier || !(ALLOWED_TIERS as readonly string[]).includes(tier)) {
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
  // The command first shows a pending report, then the composed one: the gate checks the last, and
  // the earlier ones (the pending report) separately.
  expect(reports.length).toBeGreaterThanOrEqual(2);
  expect(writes).toHaveLength(1);
  return { report: reports[reports.length - 1], pending: reports.slice(0, -1), result: writes[0].payload as NmrPredictionResult };
}

/** `hdResonances`: the least number of distinct ¹H resonances that must carry an H–D coupling. */
const STRUCTURES = [
  { name: "ethanol-1-d1", smiles: "[2H]C(C)O", hdResonances: 1 },
  { name: "benzene-d5 (C6D5H)", smiles: "[2H]c1c([2H])c([2H])c([2H])c([2H])c1", hdResonances: 1 },
  { name: "CH2D-CH3", smiles: "[2H]CC", hdResonances: 1 },
  { name: "butane-2-d1 (CH3 and CH2 both couple to D)", smiles: "[2H]C(C)CC", hdResonances: 2 }
] as const;

const PATHS = [
  { name: "GNN (bundled ONNX model)", fetchAsset: readAsset, method: "GNN prediction" },
  { name: "HOSE fallback (model unavailable)", fetchAsset: missingAsset, method: "HOSE lookup" }
] as const;

describe("release label gate: the wording the gate checks against", () => {
  it("is the documented wording, exported by src/report/labels.ts", () => {
    // Pinned so a reworded label is a deliberate, visible change to this file too.
    expect(ESTIMATE_PHRASE).toBe("typical first-order estimate");
    expect(ESTIMATE_SHORT_LABEL).toBe("H–D est.");
    expect(RULE_ESTIMATE_MARKER).toBe("est.");
    expect(HD_ESTIMATE_CAPTION_SENTENCE).toContain("H–D couplings are typical first-order estimates");
    expect(HH_ESTIMATE_CAPTION_SENTENCE).toContain("¹H–¹H couplings are typical first-order estimates");
    expect(HD_SVG_FOOTER_PREFIX).toBe("H–D: typical first-order estimates; spin-1 intensities; ");
    expect(J_HD_STATEMENT).toContain("0.1535");
  });
});

describe("release label gate: the pending report", () => {
  it("shows no H–D value without the marker", () => {
    const molecule: PluginSelectedMolecule = {
      objectId: "m1", documentId: "doc1", pageId: "p1", structureFormat: "smiles", structure: "[2H]CC", sourceFingerprint: "fp"
    };
    expect(pendingProblems(composePendingReport(molecule, ["1H"]))).toEqual([]);
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
            // The structure really has H–D couplings for the gate to bite on, on as many distinct resonances as intended.
            expect(resonances.filter(hasDeuteriumCoupling).length).toBeGreaterThanOrEqual(structure.hdResonances);
          });

          it("labels every H–D coupling with the first-order-estimate wording", () => {
            expect(hdWordingProblems(composed.report, composed.result), "H–D wording problems").toEqual([]);
          });

          it("marks every H–D-coupled resonance in its J cell, its peak labels and the caption", () => {
            expect(perResonanceProblems(composed.report, composed.result), "per-resonance problems").toEqual([]);
          });

          it("marks every H–D label in the exported stick-spectrum SVG", () => {
            expect(svgProblems(composed.result), "SVG problems").toEqual([]);
          });

          it("shows no H–D value without the marker while the prediction is pending", () => {
            expect(composed.pending.length).toBeGreaterThanOrEqual(1);
            for (const report of composed.pending) expect(pendingProblems(report), "pending report problems").toEqual([]);
          });

          it("gives every ¹H shift row a method and a high/medium/low tier, never a percentage", () => {
            expect(methodAndTierProblems(composed.report, composed.result), "method/tier problems").toEqual([]);
          });
        });
      }
    });
  }
});

describe("release label gate: the checks themselves bite", () => {
  const COLUMNS = ["Nucleus", "δ (ppm)", "Method", "Equiv.", "Mult. (est.)", "J est. (Hz)", "± σ (ppm)", "Confidence", "Atoms", "Environment"];
  const row = (over: Partial<Record<string, string>> = {}): string[] => {
    const cells: Record<string, string> = {
      Nucleus: "¹H", "δ (ppm)": "1.20", Method: "GNN prediction", "Equiv.": "3", "Mult. (est.)": "t", "J est. (Hz)": "7.0",
      "± σ (ppm)": "—", Confidence: "high · s4, n=7", Atoms: "1", Environment: "env", ...over
    };
    return COLUMNS.map((column) => cells[column]);
  };
  const tableReport = (rows: string[][], extra: unknown[] = []) => ({
    title: "t",
    sections: [
      { kind: "text", title: "Legend", body: "¹H–²H couplings are typical first-order estimates: J(HD) = 0.1535 × J(HH)." },
      { kind: "table", title: "Predicted shifts", columns: COLUMNS, rows },
      ...extra
    ]
  }) as unknown as PluginPanelReport;
  const resonance = (over: Record<string, unknown> = {}) => ({
    id: "r1", nucleus: "1H", deltaPpm: 1.2, atomRefs: [{ sourceAtomIndex: 1 }], ...over
  });
  const hdResonance = (over: Record<string, unknown> = {}) => resonance({
    multiplet: { label: "tt", couplings: [{ jHz: 7, partnerCount: 2, partnerNucleus: "1H" }, { jHz: 1, partnerCount: 1, partnerNucleus: "2H" }] }, ...over
  });
  const resultOf = (...resonances: unknown[]) => ({ resonances }) as unknown as NmrPredictionResult;
  const noResult = resultOf();
  const base = tableReport([row()]);
  const figure = (peaks: { id: string; label: string }[], caption: string) =>
    ({ kind: "linkedFigure", title: "f", caption, spectrum: { nucleus: "1H", peaks } });

  it("accepts a labelled report", () => {
    expect(hdWordingProblems(base, noResult)).toEqual([]);
    expect(methodAndTierProblems(base, resultOf(resonance()))).toEqual([]);
  });

  it("names the section of an unlabelled H–D mention", () => {
    const report = { ...base, sections: [...base.sections, { kind: "text", title: "Extra", body: "H–D coupling 1.1 Hz" }] } as PluginPanelReport;
    expect(hdWordingProblems(report, noResult).join("\n")).toMatch(/section #2 \(text: "Extra"\).*H–D mention without/);
  });

  it("lets an omission notice stand without estimate wording, but not a coupling value", () => {
    const notice = (body: string) => ({ ...base, sections: [...base.sections, { kind: "text", body }] }) as PluginPanelReport;
    const omission = "H–D coupling not shown for proton host atoms 1, 2 (zero-based): geminal paths are omitted.";
    expect(hdWordingProblems(notice(omission), noResult)).toEqual([]);
    expect(hdWordingProblems(notice(`Long-range ${omission}`), noResult)).toEqual([]);
    expect(hdWordingProblems(notice(`${omission} J = 1.1 Hz`), noResult).join()).toMatch(/H–D mention without/);
    expect(hdWordingProblems(notice("H–D coupling of 1.1 Hz"), noResult).join()).toMatch(/H–D mention without/);
  });

  it("rejects a missing method and a percentage tier", () => {
    const check = (cells: Partial<Record<string, string>>) => methodAndTierProblems(tableReport([row(cells)]), resultOf(resonance())).join();
    expect(check({ Method: "—" })).toMatch(/method "—"/);
    expect(check({ Confidence: "high 90%" })).toMatch(/percentage/);
    expect(check({ Confidence: "—" })).toMatch(/tier cell/);
  });

  it("accepts est. only for a rule-estimated row, and requires it to be visibly a rule estimate", () => {
    const rule = resonance({ source: "rule-estimate" });
    const ruleRow = row({ Method: "HOSE lookup", "δ (ppm)": "≈1.20", Confidence: "est.", Environment: "rule-estimated (x)" });
    expect(methodAndTierProblems(tableReport([ruleRow]), resultOf(rule))).toEqual([]);
    // est. on a GNN / HOSE-lookup row is not a tier.
    expect(methodAndTierProblems(tableReport([row({ Confidence: "est." })]), resultOf(resonance())).join()).toMatch(/tier cell/);
    // A rule row with a database tier, or without its visible rule-estimate labels.
    expect(methodAndTierProblems(tableReport([row({ Method: "HOSE lookup" })]), resultOf(rule)).join()).toMatch(/does not start with "est\."/);
    expect(methodAndTierProblems(tableReport([ruleRow.map((c, i) => (i === 1 ? "1.20" : c))]), resultOf(rule)).join()).toMatch(/not marked "≈"/);
    expect(methodAndTierProblems(tableReport([ruleRow.map((c, i) => (i === 9 ? "env" : c))]), resultOf(rule)).join()).toMatch(/does not say "rule-estimated"/);
  });

  it("rejects a section kind it does not know", () => {
    const report = { ...base, sections: [{ kind: "chart", title: "x" }] } as unknown as PluginPanelReport;
    expect(methodAndTierProblems(report, noResult).join()).toMatch(/unknown section kind/);
  });

  it("counts H–D markers in the J cell against the resonance's ²H couplings", () => {
    const result = resultOf(hdResonance());
    const peaks = [{ id: "r1-line-0", label: "" }, { id: "r1-line-1", label: `1.20 (tt; ${HD_ESTIMATE_LABEL})` }];
    const good = tableReport([row({ "J est. (Hz)": `7.0, 1.0 (${HD_ESTIMATE_LABEL})` })], [figure(peaks, HD_ESTIMATE_CAPTION_SENTENCE)]);
    expect(perResonanceProblems(good, result)).toEqual([]);
    const unmarked = tableReport([row({ "J est. (Hz)": "7.0, 1.0" })], [figure(peaks, HD_ESTIMATE_CAPTION_SENTENCE)]);
    expect(perResonanceProblems(unmarked, result).join()).toMatch(/0 "H–D est\." marker\(s\) for 1 ²H/);
    const tooMany = tableReport([row({ "J est. (Hz)": `7.0 (${HD_ESTIMATE_LABEL}), 1.0 (${HD_ESTIMATE_LABEL})` })], [figure(peaks, HD_ESTIMATE_CAPTION_SENTENCE)]);
    expect(perResonanceProblems(tooMany, result).join()).toMatch(/2 "H–D est\." marker\(s\) for 1 ²H/);
    const stray = tableReport([row({ "J est. (Hz)": `7.0 (${HD_ESTIMATE_LABEL})` })], [figure(peaks, HD_ESTIMATE_CAPTION_SENTENCE)]);
    expect(perResonanceProblems(stray, resultOf(resonance({ multiplet: { label: "t", couplings: [{ jHz: 7, partnerCount: 2, partnerNucleus: "1H" }] } }))).join()).toMatch(/1 "H–D est\." marker\(s\) for 0 ²H/);
  });

  it("requires the H–D label on the peaks of every H–D-coupled resonance", () => {
    const result = resultOf(hdResonance(), hdResonance({ id: "r2", deltaPpm: 2.4, atomRefs: [{ sourceAtomIndex: 2 }] }));
    const cell = `7.0, 1.0 (${HD_ESTIMATE_LABEL})`;
    const rows = [row({ "J est. (Hz)": cell }), row({ "J est. (Hz)": cell, Atoms: "2" })];
    const labelled = (id: string) => ({ id, label: `1.20 (tt; ${HD_ESTIMATE_LABEL})` });
    const ok = tableReport(rows, [figure([labelled("r1-line-0"), labelled("r2-line-0")], HD_ESTIMATE_CAPTION_SENTENCE)]);
    expect(perResonanceProblems(ok, result)).toEqual([]);
    // The second resonance's label drops the marker: the first resonance's marker must not cover for it.
    const bad = tableReport(rows, [figure([labelled("r1-line-0"), { id: "r2-line-0", label: "2.40 (tt)" }], HD_ESTIMATE_CAPTION_SENTENCE)]);
    expect(perResonanceProblems(bad, result).join()).toMatch(/resonance r2.*no peak label carries/);
  });

  it("requires the H–D caption sentence, not only the H–H one", () => {
    const result = resultOf(hdResonance());
    const report = tableReport([row({ "J est. (Hz)": `7.0, 1.0 (${HD_ESTIMATE_LABEL})` })], [figure([{ id: "r1-line-0", label: `1.20 (tt; ${HD_ESTIMATE_LABEL})` }], HH_ESTIMATE_CAPTION_SENTENCE)]);
    expect(hdWordingProblems(report, result).join()).toMatch(/figure caption lacks the H–D estimate sentence/);
  });

  it("requires the estimate marker on every H–D label of the exported SVG", () => {
    const withLines = hdResonance({ equivalentNuclei: 2, multiplet: { label: "tt", couplings: [{ jHz: 7, partnerCount: 2, partnerNucleus: "1H" }, { jHz: 1, partnerCount: 1, partnerNucleus: "2H" }] } });
    const result = { ...resultOf(withLines), backend: { method: "x" } } as unknown as NmrPredictionResult;
    expect(svgProblems(result)).toEqual([]);
    // A label stripped of its marker, as the source would render it after a regression.
    const original = renderStickSpectrumSvg(result);
    expect(original).toContain(`; ${HD_ESTIMATE_LABEL})`);
    expect(svgProblems(result, original.replace(`; ${HD_ESTIMATE_LABEL})`, ")")).join()).toMatch(/multiplet label|lacks/);
    expect(svgProblems(result, original.replace(HD_SVG_FOOTER_PREFIX, "")).join()).toMatch(/footer/);
  });

  it("rejects a pending report that shows an H–D value without the marker", () => {
    const pending = { title: "t", sections: [{ kind: "text", body: "Predicting… J(HD) 1.1 Hz" }] } as PluginPanelReport;
    expect(pendingProblems(pending).join()).toMatch(/H–D mention without|coupling value without the marker/);
  });
});
