import { describe, expect, it } from "vitest";

import { isNmrError, NmrErrorCodes } from "../domain/errors";
import { normalizeStructure, toChemicalStructureInput } from "../application/normalizeStructure";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return isNmrError(error) ? error.code : `non-nmr:${String(error)}`;
  }
  throw new Error("Expected the function to throw.");
}

describe("toChemicalStructureInput", () => {
  it("rejects the unknown format", () => {
    expect(codeOf(() => toChemicalStructureInput("unknown", "c1ccccc1"))).toBe(
      NmrErrorCodes.UnsupportedStructureFormat
    );
  });

  it("rejects an empty payload", () => {
    expect(codeOf(() => toChemicalStructureInput("smiles", "   "))).toBe(NmrErrorCodes.EmptyStructure);
  });

  it("passes a supported format through", () => {
    expect(toChemicalStructureInput("smiles", "c1ccccc1")).toEqual({ format: "smiles", value: "c1ccccc1" });
  });
});

describe("normalizeStructure", () => {
  it("parses SMILES into a provider molecule with an atom count and canonical SMILES", () => {
    const { normalized } = normalizeStructure({ format: "smiles", value: "CCO" });
    expect(normalized.sourceFormat).toBe("smiles");
    expect(normalized.providerAtomCount).toBe(3);
    expect(typeof normalized.canonicalSmiles).toBe("string");
    expect(normalized.warnings).toHaveLength(0);
  });

  it("rejects an empty structure", () => {
    expect(codeOf(() => normalizeStructure({ format: "smiles", value: "" }))).toBe(NmrErrorCodes.EmptyStructure);
  });

  it("fails on an unparseable molfile", () => {
    expect(codeOf(() => normalizeStructure({ format: "molfile-v2000", value: "not a molfile at all" }))).toBe(
      NmrErrorCodes.StructureParseFailed
    );
  });

  it("warns (does not fail) on a formally charged structure", () => {
    const { normalized } = normalizeStructure({ format: "smiles", value: "C[N+](C)(C)C" });
    expect(normalized.warnings.map((warning) => warning.code)).toContain("NMR_CHARGED_STRUCTURE");
  });

  it("does not mislabel the canonical nitro resonance form as unsupported ionic chemistry", () => {
    const { normalized } = normalizeStructure({ format: "smiles", value: "O=[N+]([O-])c1ccccc1" });
    expect(normalized.warnings.map((warning) => warning.code)).not.toContain("NMR_CHARGED_STRUCTURE");
  });

  it("keeps the charged-structure warning for a noncanonical N/O ion", () => {
    const { normalized } = normalizeStructure({ format: "smiles", value: "[O-][N+](=O)(O)c1ccccc1" });
    expect(normalized.warnings.map((warning) => warning.code)).toContain("NMR_CHARGED_STRUCTURE");
  });

  it("warns when OCL preserves isotope, radical, or unsupported-element chemistry", () => {
    expect(
      normalizeStructure({ format: "smiles", value: "[13CH4]" }).normalized.warnings.map((warning) => warning.code)
    ).toContain("NMR_ISOTOPE_NOT_SUPPORTED");
    expect(
      normalizeStructure({ format: "smiles", value: "[CH3]" }).normalized.warnings.map((warning) => warning.code)
    ).toContain("NMR_RADICAL_NOT_SUPPORTED");
    expect(
      normalizeStructure({ format: "smiles", value: "[SiH4]" }).normalized.warnings.map((warning) => warning.code)
    ).toContain("NMR_UNSUPPORTED_ELEMENT");
  });

  it("preserves D but discloses first-order hydrogen matching instead of refusing it", () => {
    const { molecule, normalized } = normalizeStructure({ format: "smiles", value: "CCO[2H]" });
    expect(molecule.getAtomMass(3)).toBe(2);
    expect(normalized.warnings).toEqual([
      expect.objectContaining({
        code: "NMR_DEUTERIUM_SHIFT_NOT_MODELLED",
        message: expect.stringContaining("treated as hydrogen for database environment matching and rule estimates"),
        atomIndices: [3]
      })
    ]);
    expect(normalized.warnings[0].message).toContain("isotope shifts are not modelled (first-order)");
  });

  it.each(["[13CH3]CO[2H]", "C[15NH][2H]", "CO[3H]"])(
    "keeps the unsupported-isotope warning for other labels, including mixed D labels: %s",
    (value) => {
      const { normalized } = normalizeStructure({ format: "smiles", value });
      expect(normalized.warnings.map((warning) => warning.code)).toContain("NMR_ISOTOPE_NOT_SUPPORTED");
    }
  );
});
