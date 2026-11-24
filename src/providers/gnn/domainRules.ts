/**
 * ABSTENTION.md as plugin code: GNN declines (section 1), the HOSE fallback decision (section 2) and
 * the tiers (section 3, with the disagreement case of section 4).
 *
 * This module is a line-by-line port of the experiment's reference implementation,
 * `nmr-model-experiment/py/abstention.py` (`describe`, `heavy_atoms`, `adjacency`, `assess`, `tier`,
 * `shipped`) at commit c05b91c, which `py/evaluate.py` applies to produce the frozen results. It reads
 * the same feature rows the model sees (schema 1), so a decision here equals the evaluator's decision
 * for the same atom. Interpretations, from ABSTENTION-NOTES.md and RUN.md:
 *
 * - For a ¹H resonance, "the atom" is its host heavy-atom node, where the GNN predicts.
 * - Rules 1-3 cover the node and its graph neighbors. Rule 3 also counts a folded tritium on the node
 *   or on any heavy neighbor; folded deuterium is ²H, which is allowed.
 * - The medium tier's "≥ 500 training atoms for its element and charge state" applies to the node and
 *   to each heavy neighbor (the "margin").
 * - A HOSE match is a lookup value with a matched sphere. Rule estimates are not HOSE matches: they
 *   count as "no HOSE match" for tiers and are not used to judge disagreement.
 *
 * Pure and worker-safe: no I/O, no clock, no Node-only module.
 */
import { GNN_ATOM_FEATURE_NAMES, type GnnMoleculeFeatures } from "./featurize";

/** Decline rules, in ABSTENTION.md order (`RULES` in abstention.py). */
export const GNN_DECLINE_RULES = ["element", "charge_radical", "isotope", "size", "graph"] as const;
export type GnnDeclineRule = (typeof GNN_DECLINE_RULES)[number];

export const GNN_TIERS = ["high", "medium", "low"] as const;
export type GnnTier = (typeof GNN_TIERS)[number];

/** Thresholds fixed by ABSTENTION.md (and recorded in domain.json → thresholds). */
export const GNN_ELEMENT_MIN = 50;
export const GNN_CHARGE_STATE_MIN = 20;
export const GNN_DOMAIN_MARGIN = 500;
export const GNN_HIGH_SPHERE = 3;
export const GNN_ALLOWED_ISOTOPES: readonly string[] = ["2H", "13C"];
const RADICALS = ["none", "singlet", "doublet", "triplet"] as const;

/** The parts of `domain.json` the rules read. */
export interface GnnTrainingDomain {
  schema_version: string;
  atom_features_sha256: string;
  elements: Readonly<Record<string, number>>;
  charge_states: Readonly<Record<string, Readonly<Record<string, number>>>>;
  heavy_atoms_p999: number;
  size_limit: number;
  thresholds: {
    element_min: number;
    charge_state_min: number;
    domain_margin: number;
    allowed_isotopes: readonly string[];
    size_ui_limit: number;
  };
}

/** Plain-language reason per rule, for warnings. */
export const GNN_DECLINE_RULE_DESCRIPTIONS: Readonly<Record<GnnDeclineRule, string>> = {
  element: "an element outside the training domain (rule 1)",
  charge_radical: "a charge or radical state too rare in the training data (rule 2)",
  isotope: "an isotope label other than ²H or ¹³C (rule 3)",
  size: "a molecule larger than the training size limit (rule 4)",
  graph: "a structure the featurizer cannot represent (rule 5)"
};

interface Slots {
  elements: readonly (readonly [symbol: string, index: number])[];
  hydrogen: number;
  charge: number;
  radicals: readonly (readonly [radical: string, index: number])[];
  labeled: number;
  delta: number;
  tritium: number;
}

function buildSlots(names: readonly string[]): Slots {
  const indexOf = new Map(names.map((name, index) => [name, index] as const));
  const slot = (name: string): number => {
    const index = indexOf.get(name);
    if (index === undefined) throw new Error(`Feature schema has no ${name} slot`);
    return index;
  };
  const elements = names.flatMap((name, index) =>
    name.startsWith("element=") ? [[name.slice("element=".length), index] as const] : []
  );
  if (!elements.some(([symbol]) => symbol === "other")) throw new Error("Feature schema has no element=other slot");
  return {
    elements,
    hydrogen: slot("element=H"),
    charge: slot("formalCharge"),
    radicals: RADICALS.map((radical) => [radical, slot(`radical=${radical}`)] as const),
    labeled: slot("isotopeLabeled"),
    delta: slot("isotopeMassDelta"),
    tritium: slot("attachedTritium/4")
  };
}

const SLOTS = buildSlots(GNN_ATOM_FEATURE_NAMES);

export interface GnnNodeDescription {
  element: string;
  /** `"<formal charge>:<radical>"`, the key of `domain.json` → `charge_states.<element>`. */
  state: string;
  /** `"13C"`, `"2H"`, `"3H"` or `"<element>±<delta>"` for a labeled node; null when unlabeled. */
  isotope: string | null;
}

/** abstention.py `describe`: (element, charge state, isotope label) of one node row. */
export function describeNode(row: readonly number[]): GnnNodeDescription {
  const elements = SLOTS.elements.filter(([, index]) => row[index] === 1).map(([symbol]) => symbol);
  if (elements.length !== 1) throw new Error("Feature row does not have exactly one element slot set");
  const element = elements[0];
  const charge = row[SLOTS.charge];
  if (charge !== Math.trunc(charge)) throw new Error("Formal charge is not an integer");
  const radicals = SLOTS.radicals.filter(([, index]) => row[index] === 1).map(([radical]) => radical);
  const radical = radicals.length === 1 ? radicals[0] : "unknown";
  let isotope: string | null = null;
  if (row[SLOTS.labeled]) {
    const delta = Math.trunc(row[SLOTS.delta]);
    const known: Record<string, string> = { "C:1": "13C", "H:1": "2H", "H:2": "3H" };
    // Python's f"{delta:+d}": an explicit sign, "+0" for zero.
    isotope = known[`${element}:${delta}`] ?? `${element}${delta >= 0 ? "+" : "-"}${Math.abs(delta)}`;
  }
  // `${-0}` is "0", as Python's int(-0.0) prints.
  return { element, state: `${Math.trunc(charge)}:${radical}`, isotope };
}

/** abstention.py `heavy_atoms`: nodes that are not hydrogen nodes. */
export function heavyAtomCount(features: GnnMoleculeFeatures): number {
  return features.atoms.reduce((count, row) => count + (row[SLOTS.hydrogen] !== 1 ? 1 : 0), 0);
}

/** abstention.py `adjacency`: sorted distinct graph neighbors per node, self-loops excluded. */
export function nodeAdjacency(features: GnnMoleculeFeatures): number[][] {
  const neighbors = features.atoms.map(() => new Set<number>());
  for (const bond of features.bonds) {
    if (bond.from !== bond.to) {
      neighbors[bond.from].add(bond.to);
      neighbors[bond.to].add(bond.from);
    }
  }
  return neighbors.map((items) => [...items].sort((a, b) => a - b));
}

function count(table: Readonly<Record<string, number>> | undefined, key: string): number {
  return table !== undefined && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : 0;
}

function states(domain: GnnTrainingDomain, element: string): Readonly<Record<string, number>> | undefined {
  return Object.prototype.hasOwnProperty.call(domain.charge_states, element) ? domain.charge_states[element] : undefined;
}

export interface GnnAssessment {
  /** Decline reasons, in {@link GNN_DECLINE_RULES} order; empty when the GNN may predict. */
  declines: GnnDeclineRule[];
  /** Whether the atom clears the medium-tier margin (and no rule declined it). */
  margin: boolean;
}

/**
 * abstention.py `assess`: decline reasons for the GNN at `node` and whether the atom clears the
 * domain margin. Rules 1-3 read the node and each graph neighbor; rule 4 the whole molecule.
 */
export function assessNode(features: GnnMoleculeFeatures, node: number, domain: GnnTrainingDomain): GnnAssessment {
  const rows = features.atoms;
  if (!Number.isInteger(node) || node < 0 || node >= rows.length) throw new Error(`Node ${node} is not in the graph`);
  const reasons = new Set<GnnDeclineRule>();
  let margin = true;
  for (const atom of [node, ...nodeAdjacency(features)[node]]) {
    const { element, state, isotope } = describeNode(rows[atom]);
    const elementCount = count(domain.elements, element);
    const stateCount = count(states(domain, element), state);
    if (element === "other" || elementCount < GNN_ELEMENT_MIN) reasons.add("element");
    if (stateCount < GNN_CHARGE_STATE_MIN) reasons.add("charge_radical");
    if (isotope !== null && !GNN_ALLOWED_ISOTOPES.includes(isotope)) reasons.add("isotope");
    if (rows[atom][SLOTS.tritium] > 0) reasons.add("isotope");
    if (stateCount < GNN_DOMAIN_MARGIN) margin = false;
  }
  if (heavyAtomCount(features) > domain.size_limit) reasons.add("size");
  return { declines: GNN_DECLINE_RULES.filter((rule) => reasons.has(rule)), margin: margin && reasons.size === 0 };
}

/**
 * abstention.py `tier` (ABSTENTION.md sections 3 and 4) for an atom the GNN predicts. `lookup` and
 * `sphere` describe the HOSE match; pass null for both when there is none (a rule estimate is not a
 * match).
 */
export function gnnTier(gnn: number, lookup: number | null, sphere: number | null, band: number, margin: boolean): GnnTier {
  if (sphere !== null && lookup !== null) {
    if (Math.abs(gnn - lookup) > band) return "low";
    return sphere >= GNN_HIGH_SPHERE ? "high" : "medium";
  }
  return margin ? "medium" : "low";
}

/** Whether |GNN − lookup| exceeds the band for a HOSE match (ABSTENTION.md section 4). */
export function gnnDisagrees(gnn: number, lookup: number | null, sphere: number | null, band: number): boolean {
  return sphere !== null && lookup !== null && Math.abs(gnn - lookup) > band;
}

export type GnnShippedDecision =
  | { method: "GNN prediction"; value: number; tier: GnnTier }
  | { method: "HOSE lookup"; value: number; tier: null }
  | { method: "none"; value: null; tier: null };

/**
 * abstention.py `shipped`: the GNN value and its tier, or the HOSE fallback (section 2) when the GNN
 * declined or produced nothing. `lookup` here is any lookup value, rule estimates included; a
 * declined atom with no lookup value gets no shift.
 */
export function shippedDecision(
  gnn: number | null,
  lookup: number | null,
  declines: readonly GnnDeclineRule[],
  sphere: number | null,
  band: number,
  margin: boolean
): GnnShippedDecision {
  if (declines.length > 0 || gnn === null) {
    return lookup !== null ? { method: "HOSE lookup", value: lookup, tier: null } : { method: "none", value: null, tier: null };
  }
  return { method: "GNN prediction", value: gnn, tier: gnnTier(gnn, lookup, sphere, band, margin) };
}
