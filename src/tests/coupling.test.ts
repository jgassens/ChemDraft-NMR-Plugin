import * as OCL from "openchemlib";
import { describe, expect, it } from "vitest";

import { computeMultiplet } from "../providers/ocl/coupling";

function multiplet(smiles: string, atom: number, equivalentHostAtoms: readonly number[] = [atom]) {
  const molecule = OCL.Molecule.fromSmiles(smiles);
  molecule.ensureHelperArrays(OCL.Molecule.cHelperRings);
  return computeMultiplet(molecule, atom, equivalentHostAtoms);
}

describe("computeMultiplet (first-order topology)", () => {
  it("ethyl: CH3 is a triplet, CH2 is a quartet (³J ≈ 7 Hz)", () => {
    // CCBr — atom 0 = CH3, atom 1 = CH2.
    expect(multiplet("CCBr", 0).label).toBe("t");
    expect(multiplet("CCBr", 1).label).toBe("q");
    expect(multiplet("CCBr", 0).couplings[0].jHz).toBe(7);
  });

  it("isopropyl: methyls are a doublet, the methine is a septet", () => {
    // CC(C)Br — atoms 0,2 = CH3, atom 1 = CH.
    expect(multiplet("CC(C)Br", 0, [0, 2]).label).toBe("d");
    expect(multiplet("CC(C)Br", 1).label).toBe("sept");
  });

  it("does not split an emitted class by chemically equivalent proton partners", () => {
    expect(multiplet("CC", 0, [0, 1])).toEqual({ label: "s", couplings: [] });
    expect(multiplet("c1ccccc1", 0, [0, 1, 2, 3, 4, 5])).toEqual({ label: "s", couplings: [] });
    expect(multiplet("C1CCCCC1", 0, [0, 1, 2, 3, 4, 5])).toEqual({ label: "s", couplings: [] });
  });

  it("keeps ethanol's CH3 triplet and CH2 quartet", () => {
    expect(multiplet("CCO", 0).label).toBe("t");
    expect(multiplet("CCO", 1).label).toBe("q");
  });

  it("a proton with no coupled neighbours is a singlet", () => {
    // Neopentane-ish: C(C)(C)(C)C — the central-bonded methyls couple to nothing with H.
    // tert-butyl chloride CC(C)(C)Cl: each methyl's only heavy neighbour (the quaternary C) has no H.
    expect(multiplet("CC(C)(C)Cl", 0).label).toBe("s");
  });

  it("aldehyde α-CH couples with the small aldehyde J", () => {
    // CC=O — atom 0 = CH3 next to the aldehyde carbon (atom 1).
    const m = multiplet("CC=O", 0);
    expect(m.label).toBe("d");
    expect(m.couplings[0].kind).toBe("aldehyde");
    expect(m.couplings[0].jHz).toBeLessThan(4);
  });

  it("removes only equivalent aromatic partners from toluene's first-order patterns", () => {
    expect(multiplet("Cc1ccccc1", 2, [2, 6]).label).toBe("dd");
    expect(multiplet("Cc1ccccc1", 3, [3, 5]).label).toBe("t");
    expect(multiplet("Cc1ccccc1", 4).label).toBe("tt");
  });
});
