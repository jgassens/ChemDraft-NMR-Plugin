import type {
  PluginLinkedFigurePeak,
  PluginLinkedFigureSection,
  PluginPanelReport,
  PluginPanelSection,
  PluginSelectedMolecule
} from "@chemdraft/plugin-api";

import { isRuleEstimated, PROTON_HIGH_DISPERSION_CROSS_CHECK_PPM } from "../domain/contracts";
import type {
  NmrNucleus,
  NmrPredictionModel,
  NmrPredictionResult,
  NmrReferenceDatabase,
  NmrResonance,
  NmrStructureAtom
} from "../domain/contracts";
import type { CommandError } from "../application/mapSelection";
import { MEASURED_ACCURACY, PHOSPHORUS_MEASURED_ACCURACY } from "../providers/ocl/measuredAccuracy";
import {
  F19_AGREEMENT_BAND_PPM,
  F19_HOSE_TABLE,
  F19_MEASURED_ACCURACY,
  F19_MODEL_RELEASE,
  GNN_AGREEMENT_BANDS,
  GNN_MEASURED_ACCURACY,
  GNN_MODEL_RELEASE
} from "../providers/gnn/modelRelease";
import { DEUTERIUM_PROTON_GYROMAGNETIC_RATIO } from "../domain/firstOrderCoupling";
import { NmrWarningCodes } from "../domain/warnings";
import { deuteriumMultipletComponents, hasDeuteriumCoupling } from "./deuteriumMultiplet";

const PANEL_TITLE = "NMR Prediction";
const SYNTHETIC_DISCLAIMER =
  "Synthetic fixture values — a deterministic architecture demo, not experimental reference data.";
const EXPERIMENTAL_NOTE =
  "Statistical predictions from NMRShiftDB2 assignments (the database does not mark which are experimental). Confidence is low where the " +
  "reference population is small or only a shallow environment matched — see notices above.";
const MIXED_METHOD_NOTE =
  "Mixed result: HOSE peaks use statistics from NMRShiftDB2 assignments (the database does not mark which are experimental); " +
  "rule-estimated shifts are marked ≈ in the table and drawn muted/italic in the spectrum.";
const RULE_ONLY_NOTE =
  "Rule-estimated shifts from bounded increment and functional-class tables; no HOSE reference match " +
  "contributed to this result. Treat these values as coarse estimates, not experimental-reference predictions.";
const NO_RESULT_NOTE =
  "No applicable resonance was produced: neither the configured reference database nor the bounded " +
  "rule tables yielded a supported shift. See the notices for the omitted chemistry.";
const GNN_NOTE =
  "Shifts labeled GNN prediction come from a graph neural network trained on NMRShiftDB2 assignments (the database " +
  "does not mark which are experimental), run locally from the model files bundled with this plugin. Its tier (high, " +
  "medium, low) compares the GNN with the HOSE lookup for the same atoms and states how far the atom lies inside the " +
  "training data; tiers are names, not probabilities. Shifts labeled HOSE lookup are reference statistics shown where " +
  "the GNN declined or was unavailable.";
/** ¹⁹F scope, stated wherever a ¹⁹F result is shown (docs/f19-benchmark.md §6). */
const F19_SCOPE =
  "¹⁹F prediction is CF3 only in this version: it covers molecules whose fluorine atoms form one environment of type CF3. " +
  "Every other fluorine type, and every molecule with more than one fluorine environment, gets no ¹⁹F shift.";
const F19_NOTE =
  `${F19_SCOPE} Shifts labeled GNN prediction come from a graph neural network trained on NMRexp ¹⁹F data (CC BY 4.0), ` +
  "run locally from the model file bundled with this plugin. Its tier (high, medium, low) compares the GNN with the HOSE " +
  `lookup for the same atoms within the ${F19_AGREEMENT_BAND_PPM} ppm agreement band and states how far the atoms lie inside ` +
  "the training data; tiers are names, not probabilities. Shifts labeled HOSE lookup are NMRexp-derived reference statistics " +
  "shown where the GNN declined or was unavailable.";
const F19_NO_RESULT_NOTE = `No ¹⁹F shift is shown. ${F19_SCOPE} See the notices.`;
const OTHER_METHOD_NOTE =
  "Method-derived predicted shifts from the reported backend. They are predictions, not experimental " +
  "measurements; consult the engine provenance and notices for method-specific limits.";

function nucleusLabel(nucleus: NmrNucleus): string {
  return { "1H": "¹H", "13C": "¹³C", "31P": "³¹P", "19F": "¹⁹F" }[nucleus];
}

function nucleiLabel(nuclei: readonly NmrNucleus[]): string {
  return nuclei.map(nucleusLabel).join(" + ");
}

function structureSection(source: PluginSelectedMolecule): PluginPanelSection {
  return {
    kind: "keyValue",
    title: "Source",
    rows: [
      { label: "Object", value: source.objectId },
      { label: "Format", value: source.structureFormat }
    ]
  };
}

/** Panel shown while a prediction is running (before the worker result arrives). */
export function composePendingReport(
  source: PluginSelectedMolecule,
  nuclei: readonly NmrNucleus[]
): PluginPanelReport {
  return {
    title: PANEL_TITLE,
    sections: [
      { kind: "text", body: `Predicting ${nucleiLabel(nuclei)} shifts for the selected structure…` },
      structureSection(source)
    ]
  };
}

/** Panel shown when a prediction fails or is rejected before producing a result. */
export function composeErrorReport(source: PluginSelectedMolecule, error: CommandError): PluginPanelReport {
  return {
    title: PANEL_TITLE,
    sections: [
      { kind: "text", title: "Prediction failed", body: `${error.message} (${error.code})` },
      structureSection(source)
    ]
  };
}

/** Panel shown for a produced result: provenance, linked spectrum/structure, shift table, notices,
 * and a method-specific scientific disclaimer. */
export function composePredictionReport(
  source: PluginSelectedMolecule,
  result: NmrPredictionResult
): PluginPanelReport {
  const methods = resultMethodSummary(result);
  const sections: PluginPanelSection[] = [
    {
      kind: "keyValue",
      title: "Prediction",
      rows: [
        { label: "Method", value: resultMethodLabel(result, methods) },
        { label: "Engine", value: `${result.backend.id} v${result.backend.version}` },
        ...(result.backend.model ? [{ label: "Model", value: `${result.backend.model.id} ${result.backend.model.version}` }] : []),
        { label: "Nuclei", value: nucleiLabel(distinctNuclei(result)) || "—" },
        { label: "Resonances", value: String(result.resonances.length) }
      ]
    },
    structureSection(source)
  ];

  if (result.resonances.length > 0) {
    sections.push(...estimateProvenanceSections(result));
    // ³¹P and ¹⁹F get spectra of their own when they share a result with other nuclei.
    const figures = [
      result.resonances.filter((resonance) => resonance.nucleus !== "31P" && resonance.nucleus !== "19F"),
      result.resonances.filter((resonance) => resonance.nucleus === "31P"),
      result.resonances.filter((resonance) => resonance.nucleus === "19F")
    ].filter((resonances) => resonances.length > 0);
    if (figures.length > 1) {
      for (const resonances of figures) {
        const part = { ...result, resonances };
        sections.push(linkedFigureSection(part, resultMethodSummary(part)));
      }
    } else {
      sections.push(linkedFigureSection(result, methods));
    }
    sections.push(resonanceTable(result));
    if (methods.hasRules) {
      sections.push({
        kind: "text",
        title: "Rule-estimate legend",
        body: "≈ / est. = rule-estimated shift with no database match. Spectrum labels include est.; linked peaks are muted/italic and exported SVG sticks are dashed. Atom indices are zero-based; ¹H indices identify host atoms."
      });
    }
  }
  sections.push(...noticeSections(result));
  if (result.resonances.some(hasDeuteriumCoupling) ||
      result.warnings.some((warning) => warning.code === NmrWarningCodes.DeuteriumShiftNotModelled)) {
    sections.push({
      kind: "text",
      title: "H–D coupling legend",
      body: `¹H–²H couplings are typical first-order estimates: J(HD) = ${DEUTERIUM_PROTON_GYROMAGNETIC_RATIO.toFixed(4)} × J(HH), based on the IUPAC Recommendations 2001 magnetogyric ratios (Tables 1 and 2; R. K. Harris et al., Pure Appl. Chem. 73(11), 1795–1818, doi:10.1351/pac200173111795). D has spin I = 1: n equivalent D give 2n+1 lines, with intensities 1:1:1 (1D), 1:2:3:2:1 (2D), or 1:3:6:7:6:3:1 (3D), nested with H–H splitting. Line spacing follows the spectrometer field selected in the spectrum. Only H–D coupling over three bonds between carbons is computed. Geminal H–D is omitted because this model has no geminal H–H constant; vicinal H–D through a heteroatom and long-range H–D over four or five bonds (for example aromatic meta and para) are not shown either, and a notice names the affected protons. Isotope shifts are not modelled.`
    });
  }
  sections.push(...modelSections(result));
  sections.push(...databaseSection(result));
  sections.push({ kind: "text", body: resultDisclaimer(result, methods) });

  return {
    title: PANEL_TITLE,
    // Staleness reference (D-09): desktop chrome compares this against the live document.
    source: { objectId: source.objectId, sourceFingerprint: source.sourceFingerprint },
    sections
  };
}

function distinctNuclei(result: NmrPredictionResult): NmrNucleus[] {
  const seen = new Set<NmrNucleus>();
  for (const resonance of result.resonances) {
    seen.add(resonance.nucleus);
  }
  return [...seen];
}

/**
 * The interactive figure (ADR-0015): peaks carry the atoms they came from, and — when the backend
 * built a real molecule — the 2D depiction rides along so the desktop can annotate each atom with its
 * shift and cross-highlight on hover. Data only; the core owns all rendering and interaction.
 */
interface ResultMethodSummary {
  fixture: boolean;
  hasGnn: boolean;
  hasHose: boolean;
  hasRules: boolean;
  empty: boolean;
}

function isGnnPrediction(resonance: NmrResonance): boolean {
  return resonance.method === "GNN prediction";
}

function resultMethodSummary(result: NmrPredictionResult): ResultMethodSummary {
  return {
    fixture: result.backend.method === "fixture-fragment",
    hasGnn: result.resonances.some(isGnnPrediction),
    hasHose: result.resonances.some((resonance) => resonance.evidence?.method === "hose-fragment"),
    hasRules: result.resonances.some(isRuleEstimated),
    empty: result.resonances.length === 0
  };
}

function resultDisclaimer(result: NmrPredictionResult, methods: ResultMethodSummary): string {
  if (involvesFluorine(result)) {
    // ¹⁹F has its own model, data and scope; the other nuclei keep their own note.
    const fluorine = result.resonances.filter((resonance) => resonance.nucleus === "19F");
    const rest = { ...result, resonances: result.resonances.filter((resonance) => resonance.nucleus !== "19F") };
    const fluorineNote = fluorine.length > 0 ? F19_NOTE : F19_NO_RESULT_NOTE;
    if (rest.resonances.length === 0) return fluorineNote;
    return `${nonFluorineDisclaimer(rest, resultMethodSummary(rest))} ${fluorineNote}`;
  }
  return nonFluorineDisclaimer(result, methods);
}

function nonFluorineDisclaimer(result: NmrPredictionResult, methods: ResultMethodSummary): string {
  const note = hoseDisclaimer(result, methods);
  return methods.hasGnn ? `${GNN_NOTE} ${note}` : note;
}

/** Whether ¹⁹F was part of this result: a ¹⁹F shift, the ¹⁹F table or model, or a ¹⁹F notice. */
function involvesFluorine(result: NmrPredictionResult): boolean {
  const { backend } = result;
  return (
    result.resonances.some((resonance) => resonance.nucleus === "19F") ||
    backend.fluorineDatabase !== undefined ||
    backend.fluorineModel !== undefined ||
    backend.dataVersion === F19_HOSE_TABLE.name ||
    backend.model?.id === F19_MODEL_RELEASE.id ||
    result.warnings.some((warning) => warning.details?.nucleus === "19F")
  );
}

function hoseDisclaimer(result: NmrPredictionResult, methods: ResultMethodSummary): string {
  if (methods.hasGnn && !methods.hasHose && !methods.hasRules &&
      result.resonances.every((resonance) => resonance.nucleus !== "31P")) {
    return "Every shown shift is a GNN prediction.";
  }
  if (result.resonances.some((resonance) => resonance.nucleus === "31P")) {
    const note = "³¹P shifts use HOSE reference statistics. Confidence reflects the matched sphere and reference population.";
    if (result.resonances.every((resonance) => resonance.nucleus === "31P")) return note;
    return `${methods.hasRules ? MIXED_METHOD_NOTE : EXPERIMENTAL_NOTE} ${note}`;
  }
  if (methods.empty && result.warnings.some((warning) =>
    warning.code === NmrWarningCodes.PhosphorusDatabaseNotInstalled || warning.details?.nucleus === "31P"
  )) {
    return "No applicable resonance was produced. See the notices for the database and its coverage.";
  }
  if (methods.empty) return NO_RESULT_NOTE;
  if (methods.fixture) return SYNTHETIC_DISCLAIMER;
  if (methods.hasHose && methods.hasRules) return MIXED_METHOD_NOTE;
  if (methods.hasRules) return RULE_ONLY_NOTE;
  if (methods.hasHose || result.backend.method === "hose-fragment") return EXPERIMENTAL_NOTE;
  return OTHER_METHOD_NOTE;
}

function resultMethodLabel(result: NmrPredictionResult, methods: ResultMethodSummary): string {
  if (methods.empty) return "no applicable prediction";
  if (methods.hasGnn) {
    return ["GNN prediction", ...(methods.hasHose ? ["HOSE lookup"] : []), ...(methods.hasRules ? ["rule-estimated"] : [])].join(" + ");
  }
  if (methods.hasHose && methods.hasRules) return "HOSE lookup + rule-estimated";
  if (methods.hasRules) return "rule-estimated";
  if (methods.hasHose) return "HOSE lookup";
  return backendMethodName(result.backend.method);
}

/** User-facing name for a backend method id. Raw ids (e.g. `hose-fragment`) never reach the panel
 *  text; the names match the per-resonance method labels. */
function backendMethodName(method: string): string {
  switch (method) {
    case "hose-fragment":
      return "HOSE lookup";
    case "gnn":
      return "GNN prediction";
    case "fixture-fragment":
      return "synthetic fixture";
    case "dft":
      return "DFT calculation";
    case "hybrid":
      return "hybrid method";
    default:
      return "predicted (other method)";
  }
}

function linkedFigureSection(result: NmrPredictionResult, methods: ResultMethodSummary): PluginLinkedFigureSection {
  const nucleus = result.resonances[0]?.nucleus ?? "13C";
  // With GNN predictions in the spectrum, the comparison is GNN versus HOSE lookup; the increment
  // comparison of HOSE-only spectra is not mixed into it.
  const gnnComparison = methods.hasGnn;
  const peaks: PluginLinkedFigurePeak[] = result.resonances.flatMap((resonance) => {
    const peak: PluginLinkedFigurePeak = {
      id: resonance.id,
      ppm: resonance.deltaPpm,
      intensity: resonance.equivalentNuclei ?? 1,
      label: `${resonance.deltaPpm.toFixed(2)}${isRuleEstimated(resonance) ? " est." : ""}`,
      atomIndices: resonance.atomRefs.map((ref) => ref.sourceAtomIndex)
    };
    const tier = confidenceTier(resonance);
    // The host uses this flag to disclose rule estimates in spectrum exports.
    if (isRuleEstimated(resonance)) {
      peak.estimated = true;
    } else if (tier === "high" || tier === "medium" || tier === "low") {
      peak.confidence = tier;
    }
    // Expose every chemically applicable HOSE/increment pair to the figure. `disagrees` controls
    // interpretation only; it never gates the user's access to an available table calculation.
    if (gnnComparison) {
      if (resonance.reference) peak.alternativePpm = resonance.reference.deltaPpm;
    } else if (resonance.crossCheck) {
      peak.alternativePpm = resonance.crossCheck.incrementPpm;
    }
    const couplings = resonance.multiplet?.couplings ?? [];
    const components = deuteriumMultipletComponents(resonance);
    if (components) {
      return components.map((component, index) => ({
        ...peak,
        id: `${peak.id}-line-${index}`,
        intensity: peak.intensity * component.intensity,
        label: index === components.length - 1 ? `${peak.label} (${resonance.multiplet?.label}; H–D est.)` : "",
        ...(component.separationHz === 0 ? {} : {
          couplings: [{ jHz: component.separationHz, partnerCount: 1 }]
        })
      }));
    }
    if (couplings.length > 0) {
      peak.couplings = couplings.map((coupling) => ({ jHz: coupling.jHz, partnerCount: coupling.partnerCount }));
    }
    return peak;
  });
  // A user may switch to "Show both" after the initial render. Include alternatives in the initial
  // domain so the added comparison peak cannot fall off-canvas.
  const shifts = peaks.flatMap((peak) =>
    peak.alternativePpm === undefined ? [peak.ppm] : [peak.ppm, peak.alternativePpm]
  );

  const section: PluginLinkedFigureSection = {
    kind: "linkedFigure",
    title: `Predicted ${nucleusLabel(nucleus)} NMR${nucleus === "19F" ? " (CF3 only)" : ""}`,
    caption: figureCaption(methods, nucleus) + (result.resonances.some(hasDeuteriumCoupling)
      ? " H–D couplings are typical first-order estimates; H–D multiplets use spin-1 intensities and follow the selected spectrometer field (see H–D coupling legend)."
      : ""),
    spectrum: {
      nucleus,
      domain: spectrumDomain(nucleus, shifts),
      reversed: true,
      peaks,
      ...(gnnComparison
        ? { comparison: { primaryLabel: "GNN", alternativeLabel: "HOSE lookup", alternativeMarker: "ₕ" } }
        : nucleus === "1H" && methods.hasHose
        ? {
            comparison: {
              primaryLabel: "HOSE",
              alternativeLabel: "increment",
              alternativeMarker: "ᵢ"
            }
          }
        : {})
    }
  };

  if ((methods.hasHose || methods.hasGnn) && nucleus !== "31P" && nucleus !== "19F") {
    // Measured 106/196 CDCl₃ in the NMReDATA sample (then D₂O, DMSO-d₆, …): predominant, not uniform.
    // Only stated for measured-data results — the synthetic fixture has no solvent context.
    section.spectrum.solvent = "CDCl₃ (predominant reference solvent; mixed corpus)";
  }

  if (result.depiction) {
    // The host draws each non-carbon atom's `element` string as its label and has no separate charge,
    // radical or isotope field, so those marks travel in the label ("N+", "O−", "13C", "C•").
    const labels = result.depiction.atoms.map(depictionAtomLabel);
    if (labels.every((label): label is string => label !== undefined)) {
      section.structure = {
        atoms: result.depiction.atoms.map((atom, position) => ({ index: atom.index, x: atom.x, y: atom.y, element: labels[position] })),
        bonds: result.depiction.bonds.map((bond) => ({ from: bond.from, to: bond.to, order: bond.order }))
      };
    } else {
      // Never draw a structure that silently loses a charge, radical or isotope label.
      section.caption = section.caption ? `${section.caption} ${STRUCTURE_OMITTED_NOTICE}` : STRUCTURE_OMITTED_NOTICE;
    }
  }

  return section;
}

const STRUCTURE_OMITTED_NOTICE =
  "Structure drawing omitted: an atom's charge, radical or isotope state cannot be drawn faithfully here.";
const MINUS_SIGN = "\u2212";

/** The drawn label for one depiction atom: isotope mass, element, radical dots and formal charge
 *  (e.g. "N+", "O−", "13C", "C•", "Fe2+"). `undefined` when a state has no faithful mark (a singlet
 *  radical pair, or a non-integer charge or mass), so the caller omits the drawing instead. */
export function depictionAtomLabel(atom: NmrStructureAtom): string | undefined {
  let label = atom.element;
  if (atom.isotopeMass !== undefined) {
    if (!Number.isInteger(atom.isotopeMass) || atom.isotopeMass <= 0) return undefined;
    label = `${atom.isotopeMass}${label}`;
  }
  if (atom.radical === "doublet") {
    label += "•";
  } else if (atom.radical === "triplet") {
    label += "••";
  } else if (atom.radical !== undefined) {
    return undefined;
  }
  const charge = atom.charge ?? 0;
  if (!Number.isInteger(charge)) return undefined;
  if (charge !== 0) {
    label += `${Math.abs(charge) === 1 ? "" : Math.abs(charge)}${charge > 0 ? "+" : MINUS_SIGN}`;
  }
  return label;
}

function figureCaption(methods: ResultMethodSummary, nucleus: NmrNucleus): string {
  const interaction =
    (nucleus === "31P"
      ? "Peaks identify the matched phosphorus atoms. "
      : nucleus === "19F"
      ? "¹⁹F is CF3 only in this version; the peak identifies the CF3 fluorine atoms, and couplings are not shown. "
      : "¹H–¹H couplings are typical first-order estimates. ") +
    "Peak height represents predicted equivalent nuclei, not experimental integration. " +
    "Scroll to zoom, drag to pan; hover a peak to highlight its atoms.";
  if (methods.fixture) return `Synthetic fixture spectrum. ${interaction}`;
  if (methods.hasGnn) {
    return `GNN-predicted spectrum${methods.hasHose || methods.hasRules ? "; HOSE lookup values where the GNN declined" : ""}. ` +
      `Peak shading follows the GNN tier; "Show both" adds the HOSE lookup value where one exists. ${interaction}`;
  }
  if (methods.hasHose && methods.hasRules) {
    return `Mixed HOSE and rule-estimated spectrum; muted italic peaks labelled est. mark rule estimates. ${interaction}`;
  }
  if (methods.hasRules) {
    return `Rule-estimated spectrum; muted italic peaks labelled est. mark coarse table estimates. ${interaction}`;
  }
  return interaction;
}

/**
 * ppm window to plot: just the predicted peaks plus a small buffer, snapped to a clean edge — not the
 * whole conventional range. A ~1 ppm (¹H) / ~10 ppm (¹³C) margin keeps a little breathing room without
 * a screenful of empty baseline.
 */
function spectrumDomain(nucleus: NmrNucleus, shifts: readonly number[]): { min: number; max: number } {
  if (shifts.length === 0) {
    return { "1H": { min: 0, max: 12 }, "13C": { min: 0, max: 220 }, "31P": { min: -10, max: 10 }, "19F": { min: -200, max: 0 } }[nucleus];
  }
  const buffer = nucleus === "1H" ? 1 : 10;
  const snap = nucleus === "1H" ? 0.5 : 5;
  const lo = Math.min(...shifts) - buffer;
  const hi = Math.max(...shifts) + buffer;
  return { min: Math.floor(lo / snap) * snap, max: Math.ceil(hi / snap) * snap };
}

function resonanceTable(result: NmrPredictionResult): PluginPanelSection {
  // Results that carry method labels (every result of the GNN-first predictor) show them in their own
  // column; older session data and the fixture have none, so their layout is unchanged.
  const labeled = result.resonances.some((resonance) => resonance.method !== undefined);
  const rows = [...result.resonances]
    .sort((a, b) => b.deltaPpm - a.deltaPpm)
    .map((resonance) => {
      const estimated = isRuleEstimated(resonance);
      return [
        nucleusLabel(resonance.nucleus),
        `${estimated ? "≈" : ""}${resonance.deltaPpm.toFixed(2)}`,
        ...(labeled ? [resonance.method ?? "—"] : []),
        String(resonance.equivalentNuclei ?? 1),
        resonance.multiplet?.label ?? "—",
        formatCouplings(resonance),
        formatUncertainty(resonance),
        confidenceCell(resonance),
        resonance.atomRefs.map((ref) => ref.sourceAtomIndex).join(", "),
        estimated
          ? `rule-estimated (${resonance.evidence?.estimator?.method ?? "unknown rule"})`
          : resonance.evidence?.environmentCode ?? resonance.reference?.environmentCode ?? "—"
      ];
    });

  return {
    kind: "table",
    title: "Predicted shifts",
    columns: [
      "Nucleus",
      "δ (ppm)",
      ...(labeled ? ["Method"] : []),
      "Equiv.",
      "Mult. (est.)",
      "J est. (Hz)",
      "± σ (ppm)",
      "Confidence",
      "Atoms",
      "Environment"
    ],
    rows
  };
}

/** First-order coupling constants (estimated, topology-based) for a resonance; "—" when none. */
function formatCouplings(resonance: NmrResonance): string {
  const couplings = resonance.multiplet?.couplings ?? [];
  return couplings.length === 0 ? "—" : couplings.map((coupling) =>
    coupling.jHz.toFixed(1) + (coupling.partnerNucleus === "2H" ? " (H–D est.)" : "")
  ).join(", ");
}

function formatUncertainty(resonance: NmrResonance): string {
  const sigma = resonance.uncertainty?.standardDeviationPpm;
  return sigma === undefined ? "—" : sigma.toFixed(2);
}

// Honest confidence comes from the *applicability* of the match, not a fabricated score: how specific
// the matched environment is (HOSE sphere depth) and how well-populated its reference is (n). These
// mirror the notices the predictor already raises — LowHoseSphereMatch (sphere ≤ 1) and
// SmallReferencePopulation (n < 3) — so the column and the notices never disagree.
const CONFIDENCE_MIN_POPULATION = 3; // mirrors OclHosePredictor SMALL_POPULATION_THRESHOLD
const CONFIDENCE_HIGH_POPULATION = 8; // a healthy reference population, well above the small-population floor
const CONFIDENCE_HIGH_SPHERE = 3; // a specific (≥3-bond) environment, not a shallow class match

type ConfidenceTier = "high" | "medium" | "low" | "estimated" | "unknown";

/** Machine-readable confidence tier from match applicability. Shared by the table label and the
 *  figure peak (low-confidence peaks are drawn muted). `estimated` = rule guess (never a DB match);
 *  `unknown` = a match with no sphere/n basis (e.g. the synthetic fixture). */
function confidenceTier(resonance: NmrResonance): ConfidenceTier {
  const evidence = resonance.evidence;
  if (isGnnPrediction(resonance)) {
    return resonance.tier ?? "unknown";
  }
  if (isRuleEstimated(resonance)) {
    return "estimated";
  }
  const sphere = evidence?.matchedSphere;
  const n = evidence?.sampleCount;
  if (sphere === undefined || n === undefined) {
    return "unknown";
  }
  if (sphere <= 1 || n < CONFIDENCE_MIN_POPULATION) {
    return "low";
  }
  if (sphere >= CONFIDENCE_HIGH_SPHERE && n >= CONFIDENCE_HIGH_POPULATION) {
    return "high";
  }
  return "medium";
}

/**
 * Per-peak confidence label carrying its own basis (sphere depth + n) so the number is self-explaining:
 * `high · s4, n=42`. A rule-estimated peak is never a database match → `est.`; a match with no
 * applicability data (e.g. the synthetic fixture) → `—`.
 */
function confidenceLabel(resonance: NmrResonance): string {
  const tier = confidenceTier(resonance);
  if (tier === "estimated") {
    return "est.";
  }
  if (tier === "unknown") {
    return "—";
  }
  const { matchedSphere, sampleCount } = resonance.evidence ?? {};
  return `${tier} · s${matchedSphere}, n=${sampleCount}`;
}

/** Confidence label plus every paired increment value. The table always shows both numbers
 * transparently; `disagrees` controls notice emphasis, not whether the second opinion is visible. */
function confidenceCell(resonance: NmrResonance): string {
  if (isGnnPrediction(resonance)) {
    // The GNN tier, then the HOSE lookup value for the same atoms: both numbers are always shown.
    const tier = resonance.tier ?? "—";
    const reference = resonance.reference;
    const lookup = reference
      ? ` · HOSE ${reference.deltaPpm.toFixed(2)} (s${reference.matchedSphere}, n=${reference.sampleCount})`
      : " · no HOSE match";
    return `${tier}${resonance.disagreesWithReference ? " · model and reference lookup disagree" : ""}${lookup}`;
  }
  const base = confidenceLabel(resonance);
  const declined = resonance.modelDeclines?.length ? ` · GNN declined (${resonance.modelDeclines.join(", ")})` : "";
  if (resonance.crossCheck) {
    return `${base} · vs inc ${resonance.crossCheck.incrementPpm.toFixed(2)}${declined}`;
  }
  return `${base}${declined}`;
}

/** The GNN models behind the result: the ¹H/¹³C model and, separately, the ¹⁹F model. */
function modelSections(result: NmrPredictionResult): PluginPanelSection[] {
  const { model, fluorineModel } = result.backend;
  return [model, fluorineModel].flatMap((entry) => {
    if (!entry) return [];
    return entry.id === F19_MODEL_RELEASE.id ? fluorineModelSections(entry, result) : gnnModelSections(entry);
  });
}

/**
 * The ¹⁹F model: identity, scope (CF3 only), training data and its license, the tier rules, and the
 * measured figures of the combined predictor next to their partitions. The figures describe exactly
 * this model with exactly the shipped table, so they are shown only when the result names this model
 * release and its ¹⁹F table carries the frozen checksum.
 */
function fluorineModelSections(model: NmrPredictionModel, result: NmrPredictionResult): PluginPanelSection[] {
  const rows = [
    { label: "Model", value: `${model.id} ${model.version} (graph neural network, ONNX)` },
    { label: "Scope", value: "CF3 only: molecules with one fluorine environment of type CF3" },
    { label: "Training data", value: model.trainingData },
    { label: "Data license", value: model.dataLicense }
  ];
  const table = result.backend.fluorineDatabase ?? result.backend;
  if (
    model.version === F19_MODEL_RELEASE.version &&
    table.dataVersion === F19_HOSE_TABLE.name &&
    table.dataChecksum === F19_HOSE_TABLE.inputSha256
  ) {
    rows.push(
      { label: "Measured MAE (¹⁹F, CF3 only, selected on the gate)", value: F19_MEASURED_ACCURACY.gate },
      { label: "Measured MAE (¹⁹F, CF3 only, NMRexp check)", value: F19_MEASURED_ACCURACY.inSourceTest }
    );
  }
  return [
    { kind: "keyValue", title: "¹⁹F GNN model (CF3 only)", rows },
    {
      kind: "text",
      title: "¹⁹F GNN tiers",
      body:
        `high: a HOSE match at sphere 3 or deeper agrees with the GNN within the agreement band (¹⁹F ${F19_AGREEMENT_BAND_PPM} ppm). ` +
        "medium: a sphere 1–2 HOSE match agrees within the band, or there is no HOSE match and the atoms and their neighbors are well represented in the training data. " +
        "low: the GNN and the HOSE lookup disagree beyond the band (both values are shown, never averaged), or the atoms are in the training domain only by the minimum counts. " +
        "Where the GNN declines (rare element, charge or radical state, isotope label, size, or an unsupported structure), the HOSE lookup value is shown instead with its own tier; with no HOSE value, no shift is shown. " +
        "These figures and tiers apply to CF3 groups only."
    }
  ];
}

/** The ¹H/¹³C GNN model: identity, training data and its license, the tier rules, and the measured
 *  test-set error, always next to the partition it was measured on (ABSTENTION.md section 5). */
function gnnModelSections(model: NmrPredictionModel): PluginPanelSection[] {
  const rows = [
    { label: "Model", value: `${model.id} ${model.version} (graph neural network, ONNX)` },
    { label: "Training data", value: model.trainingData },
    { label: "Data license", value: model.dataLicense }
  ];
  if (model.id === GNN_MODEL_RELEASE.id && model.version === GNN_MODEL_RELEASE.version) {
    for (const nucleus of model.nuclei) {
      if (nucleus !== "1H" && nucleus !== "13C") continue;
      rows.push({
        label: `Measured MAE (${nucleiLabel([nucleus])})`,
        value: `${GNN_MEASURED_ACCURACY.maePpm[nucleus]} ppm — ${GNN_MEASURED_ACCURACY.partition}; ${GNN_MEASURED_ACCURACY.opening}`
      });
    }
  }
  const bands = model.nuclei
    .flatMap((nucleus) => (nucleus === "1H" || nucleus === "13C" ? [`${nucleiLabel([nucleus])} ${GNN_AGREEMENT_BANDS[nucleus]} ppm`] : []))
    .join(", ");
  return [
    { kind: "keyValue", title: "GNN model", rows },
    {
      kind: "text",
      title: "GNN tiers",
      body:
        `high: a HOSE match at sphere 3 or deeper agrees with the GNN within the agreement band (${bands}). ` +
        "medium: a sphere 1–2 HOSE match agrees within the band, or there is no HOSE match and the atom and its neighbors are well represented in the training data. " +
        "low: the GNN and the HOSE lookup disagree beyond the band (both values are shown, never averaged), or the atom is in the training domain only by the minimum counts. " +
        "Where the GNN declines an atom (rare element, charge or radical state, isotope label, size, or an unsupported structure), the HOSE lookup value is shown instead; with no HOSE value, no shift is shown."
    }
  ];
}

/** Database provenance (ADR-0014): name, version, license, source + attribution, when the backend
 *  carries it (the OCL-native predictor does; the fixture does not). */
function databaseSection(result: NmrPredictionResult): PluginPanelSection[] {
  const { backend } = result;
  const { phosphorusDatabase, fluorineDatabase } = backend;
  const nuclei = distinctNuclei(result);
  const sections = referenceDatabaseSections(
    backend,
    backend.id,
    nuclei.filter((nucleus) => !(phosphorusDatabase && nucleus === "31P") && !(fluorineDatabase && nucleus === "19F"))
  );
  if (phosphorusDatabase) {
    sections.push(...referenceDatabaseSections(phosphorusDatabase, backend.id, nuclei.filter((nucleus) => nucleus === "31P")));
  }
  if (fluorineDatabase) {
    sections.push(...referenceDatabaseSections(fluorineDatabase, backend.id, nuclei.filter((nucleus) => nucleus === "19F")));
  }
  return sections;
}

function referenceDatabaseSections(
  database: NmrReferenceDatabase,
  backendId: string,
  nuclei: readonly NmrNucleus[]
): PluginPanelSection[] {
  if (!database.license && !database.source) return [];
  const rows = [
    { label: "Database", value: database.dataVersion ?? backendId },
    { label: "Version", value: database.version }
  ];
  if (database.license) {
    rows.push({ label: "License", value: database.license });
  }
  if (database.source) {
    rows.push({ label: "Source", value: database.source });
  }
  rows.push(...measuredAccuracyRows(database.dataChecksum, nuclei, backendId === "chemdraft.gnn-hose"));
  const sections: PluginPanelSection[] = [{ kind: "keyValue", title: "Reference database", rows }];
  if (database.attribution) {
    sections.push({ kind: "text", body: database.attribution });
  }
  return sections;
}

/** Held-out benchmark error for the nuclei in this result — shown only when the active database was
 * compiled from the exact corpus the benchmark measured (checksum equality). A rebuild from any
 * other corpus silently drops the claim until the benchmark is rerun (ADR-0026). */
function measuredAccuracyRows(
  dataChecksum: string | undefined,
  nuclei: readonly NmrNucleus[],
  lookupOfGnnResult = false
): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  for (const nucleus of nuclei) {
    const benchmark = nucleus === "31P" ? PHOSPHORUS_MEASURED_ACCURACY : MEASURED_ACCURACY;
    if (dataChecksum !== benchmark.corpusSha256) continue;
    const measured = benchmark.nuclei[nucleus];
    if (!measured) continue;
    const tiers = (["high", "medium", "low"] as const)
      .flatMap((tier) => {
        const stats = measured.byTier[tier];
        return stats ? [`${tier} ${stats.medianAe}`] : [];
      })
      .join(" / ");
    rows.push({
      label: `${lookupOfGnnResult && nucleus !== "31P" ? "HOSE lookup measured accuracy" : "Measured accuracy"} (${nucleiLabel([nucleus])})`,
      value: `median |Δ| ${measured.hose.medianAe} ppm (${tiers}) — ${nucleus === "31P"
        ? PHOSPHORUS_MEASURED_ACCURACY.partition
        : "held-out benchmark"}, ${benchmark.benchmarkDate}`
    });
  }
  return rows;
}

/** Exact per-estimate identity for mixed-method results. The overall backend remains the HOSE engine;
 * this section prevents a displayed additive value from inheriting database provenance by accident. */
function estimateProvenanceSections(result: NmrPredictionResult): PluginPanelSection[] {
  const estimates = new Map<string, { id: string; version: string; method: string }>();
  for (const resonance of result.resonances) {
    for (const estimator of [resonance.evidence?.estimator, resonance.crossCheck?.estimator]) {
      if (!estimator) continue;
      estimates.set(`${estimator.id}@${estimator.version}:${estimator.method}`, estimator);
    }
  }
  if (estimates.size === 0) return [];
  return [
    {
      kind: "keyValue",
      title: "Estimate provenance",
      rows: [...estimates.values()].map((estimator, index) => ({
        label: estimates.size === 1 ? "Estimator" : `Estimator ${index + 1}`,
        value: `${estimator.id} v${estimator.version} · ${estimator.method}`
      }))
    }
  ];
}

function noticeSections(result: NmrPredictionResult): PluginPanelSection[] {
  const lines: string[] = [];
  const agreement = incrementAgreementSummary(result);
  if (agreement) lines.push(`• ${agreement}`);
  const eligibility = incrementEligibilitySummary(result);
  if (eligibility) lines.push(`• ${eligibility}`);
  lines.push(...result.warnings.map((warning) => `• ${warning.message} (${warning.code})`));
  if (lines.length === 0) return [];
  return [
    {
      kind: "text",
      title: "Notices",
      body: lines.join("\n")
    }
  ];
}

function incrementEligibilitySummary(result: NmrPredictionResult): string | undefined {
  const highDispersionCount = result.resonances.filter(
    (resonance) => resonance.crossCheck?.reason === "high-dispersion"
  ).length;
  if (highDispersionCount === 0) return undefined;
  const noun = highDispersionCount === 1 ? "HOSE resonance" : "HOSE resonances";
  return `${highDispersionCount} compared ${noun} ${highDispersionCount === 1 ? "has" : "have"} a broad reference distribution (σ ≥ ${PROTON_HIGH_DISPERSION_CROSS_CHECK_PPM.toFixed(2)} ppm); that spread affects interpretation, not comparison availability.`;
}

/** Plain-language method comparison for the report's Notices area. Only paired, applicable
 * HOSE/increment values participate; unmatched rule estimates have no HOSE value to compare against. */
function incrementAgreementSummary(result: NmrPredictionResult): string | undefined {
  const hoseResonances = result.resonances.filter(
    (resonance) => resonance.nucleus === "1H" && resonance.evidence?.method === "hose-fragment"
  );
  if (hoseResonances.length === 0) return undefined;

  const comparisons = hoseResonances.flatMap((resonance) =>
    resonance.crossCheck ? [{ hosePpm: resonance.deltaPpm, comparison: resonance.crossCheck }] : []
  );
  const coverage = `${comparisons.length} of ${hoseResonances.length} HOSE-predicted resonances`;
  if (comparisons.length === 0) {
    return `Additive-increment table calculations are not applicable to any of the ${hoseResonances.length} HOSE-predicted resonances in this structure; the shift comparison is HOSE-only.`;
  }

  const disagreementCount = comparisons.filter(({ comparison }) => comparison.disagrees).length;
  const agreementCount = comparisons.length - disagreementCount;
  const coverageIsLimited = comparisons.length < 3 || comparisons.length / hoseResonances.length < 0.5;
  if (coverageIsLimited) {
    if (comparisons.length === 1) {
      const [{ hosePpm, comparison }] = comparisons;
      const difference = Math.abs(hosePpm - comparison.incrementPpm).toFixed(2);
      return `Limited additive-increment comparison: ${coverage} has an applicable table calculation. It differs from HOSE by ${difference} ppm and ${comparison.disagrees ? "exceeds" : "is within"} the comparison threshold. Coverage is too limited to assess general agreement.`;
    }
    return `Limited additive-increment comparison: ${coverage} have applicable table calculations; ${agreementCount} are within the comparison threshold and ${disagreementCount} exceed it. Coverage is too limited to assess general agreement.`;
  }

  const allCompared =
    comparisons.length === 1
      ? "the compared resonance"
      : `all ${comparisons.length} compared resonances`;
  if (disagreementCount === 0) {
    return `Additive-increment table calculations are in general agreement with the HOSE predictions for ${allCompared} (${coverage} covered).`;
  }
  if (agreementCount === 0) {
    return `Additive-increment table calculations are not in general agreement with the HOSE predictions: ${allCompared} ${comparisons.length === 1 ? "exceeds" : "exceed"} the disagreement threshold (${coverage} covered).`;
  }
  return `Additive-increment table calculations show mixed agreement with the HOSE predictions: ${agreementCount} of ${comparisons.length} are within the comparison threshold and ${disagreementCount} exceed it (${coverage} covered).`;
}
