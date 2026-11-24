import * as OCL from "openchemlib";
import { describe, expect, it } from "vitest";

import {
  assessNode,
  describeNode,
  gnnDisagrees,
  gnnTier,
  heavyAtomCount,
  nodeAdjacency,
  shippedDecision,
  type GnnTrainingDomain
} from "../providers/gnn/domainRules";
import { featurizeMolecule, GNN_ATOM_FEATURE_NAMES } from "../providers/gnn/featurize";
import { GNN_TRAINING_DOMAIN } from "../providers/gnn/trainingDomain";

/**
 * Unit checks of the port of nmr-model-experiment/py/abstention.py. The same functions were compared
 * with the Python reference on all 38,985 validation targets of run nmrexp-02 (identical declines,
 * margins, tiers and shipped decisions; see docs/gnn-model.md).
 */

function row(values: Record<string, number>): number[] {
  const out = new Array<number>(GNN_ATOM_FEATURE_NAMES.length).fill(0);
  for (const [name, value] of Object.entries(values)) {
    const index = GNN_ATOM_FEATURE_NAMES.indexOf(name);
    if (index < 0) throw new Error(name);
    out[index] = value;
  }
  return out;
}

function features(smiles: string) {
  return featurizeMolecule(OCL.Molecule.fromSmiles(smiles));
}

describe("describeNode (abstention.py describe)", () => {
  it("reads element, charge state and isotope label as the evaluator does", () => {
    expect(describeNode(row({ "element=C": 1, "radical=none": 1 }))).toEqual({ element: "C", state: "0:none", isotope: null });
    expect(describeNode(row({ "element=N": 1, formalCharge: 1, "radical=none": 1 }))).toEqual({ element: "N", state: "1:none", isotope: null });
    expect(describeNode(row({ "element=O": 1, formalCharge: -1, "radical=doublet": 1 })).state).toBe("-1:doublet");
    // No radical slot set reads "unknown", as Python does for anything but exactly one slot.
    expect(describeNode(row({ "element=C": 1 })).state).toBe("0:unknown");
    expect(describeNode(row({ "element=C": 1, "radical=none": 1, isotopeLabeled: 1, isotopeMassDelta: 1 })).isotope).toBe("13C");
    expect(describeNode(row({ "element=H": 1, "radical=none": 1, isotopeLabeled: 1, isotopeMassDelta: 1 })).isotope).toBe("2H");
    expect(describeNode(row({ "element=H": 1, "radical=none": 1, isotopeLabeled: 1, isotopeMassDelta: 2 })).isotope).toBe("3H");
    expect(describeNode(row({ "element=N": 1, "radical=none": 1, isotopeLabeled: 1, isotopeMassDelta: 1 })).isotope).toBe("N+1");
    expect(describeNode(row({ "element=C": 1, "radical=none": 1, isotopeLabeled: 1, isotopeMassDelta: 0 })).isotope).toBe("C+0");
    expect(describeNode(row({ "element=C": 1, "radical=none": 1, isotopeLabeled: 1, isotopeMassDelta: -1 })).isotope).toBe("C-1");
  });

  it("refuses rows the schema cannot produce", () => {
    expect(() => describeNode(row({ "element=C": 1, "element=N": 1 }))).toThrow(/exactly one element/);
    expect(() => describeNode(row({ "element=C": 1, formalCharge: 0.5 }))).toThrow(/integer/);
  });
});

describe("graph helpers", () => {
  it("counts heavy atoms and lists distinct sorted neighbors", () => {
    const ethanol = features("OCC");
    expect(heavyAtomCount(ethanol)).toBe(3);
    expect(nodeAdjacency(ethanol)).toEqual([[1], [0, 2], [1]]);
  });
});

describe("assessNode (abstention.py assess)", () => {
  it("passes ordinary organic atoms with the margin", () => {
    expect(assessNode(features("CCO"), 0, GNN_TRAINING_DOMAIN)).toEqual({ declines: [], margin: true });
  });

  it("reports every rule that applies, in ABSTENTION.md order, and clears the margin only without declines", () => {
    const domain: GnnTrainingDomain = { ...GNN_TRAINING_DOMAIN, size_limit: 1, elements: { ...GNN_TRAINING_DOMAIN.elements, O: 3 } };
    expect(assessNode(features("CCO"), 1, domain)).toEqual({ declines: ["element", "size"], margin: false });
    // The far carbon does not touch O: only the molecule-wide size rule applies.
    expect(assessNode(features("CCO"), 0, domain)).toEqual({ declines: ["size"], margin: false });
  });

  it("uses the size limit as a strict upper bound (more heavy atoms than the limit)", () => {
    const propane = features("CCC");
    expect(assessNode(propane, 0, { ...GNN_TRAINING_DOMAIN, size_limit: 3 }).declines).toEqual([]);
    expect(assessNode(propane, 0, { ...GNN_TRAINING_DOMAIN, size_limit: 2 }).declines).toEqual(["size"]);
  });

  it("loses the margin, without declining, when a neighbor's state has 20–499 training atoms", () => {
    const sulfonium = features("C[S+](C)C");
    expect(assessNode(sulfonium, 0, GNN_TRAINING_DOMAIN)).toEqual({ declines: [], margin: false });
  });
});

describe("gnnTier and shippedDecision (abstention.py tier and shipped)", () => {
  it("follows section 3 and section 4", () => {
    expect(gnnTier(20, 20.5, 3, 4, false)).toBe("high");
    expect(gnnTier(20, 20.5, 2, 4, false)).toBe("medium");
    expect(gnnTier(20, 25, 4, 4, true)).toBe("low");
    expect(gnnTier(20, 24, 4, 4, true)).toBe("high");
    expect(gnnTier(20, null, null, 4, true)).toBe("medium");
    expect(gnnTier(20, null, null, 4, false)).toBe("low");
    // A rule estimate (value without a sphere) is not a match.
    expect(gnnTier(20, 90, null, 4, true)).toBe("medium");
    expect(gnnDisagrees(20, 90, null, 4)).toBe(false);
    expect(gnnDisagrees(20, 25, 1, 4)).toBe(true);
  });

  it("falls back to any lookup value on a decline, and to nothing without one", () => {
    expect(shippedDecision(20, 21, ["element"], 3, 4, true)).toEqual({ method: "HOSE lookup", value: 21, tier: null });
    expect(shippedDecision(20, null, ["size"], null, 4, true)).toEqual({ method: "none", value: null, tier: null });
    expect(shippedDecision(null, 21, [], 3, 4, true)).toEqual({ method: "HOSE lookup", value: 21, tier: null });
    expect(shippedDecision(20, 21, [], 3, 4, true)).toEqual({ method: "GNN prediction", value: 20, tier: "high" });
  });
});
