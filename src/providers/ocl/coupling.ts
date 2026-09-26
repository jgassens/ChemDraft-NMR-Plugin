import * as OCL from "openchemlib";

import type { NmrCoupling, NmrMultiplet } from "../../domain/contracts";

/**
 * First-order ¹H multiplicity + coupling estimator from the molecular topology (not from the shift
 * database). For a proton-bearing host atom it finds its coupling partners on the bond graph —
 * vicinal ³J (protons on heavy neighbours), aromatic ortho/meta, and a smaller aldehyde J — assigns a
 * class-typical J to each, merges equivalent couplings, and applies the first-order (n+1) rule to
 * produce a multiplicity label (s, d, t, q, quint, sext, sept, dd, dt, ddd, m, …). These are
 * estimates for readability, in the spirit of ChemDraw's ChemNMR — deliberately simple, not a
 * full spin simulation. Runtime OpenChemLib import; reachable only via OclHosePredictor (worker/lazy).
 */

const J_VICINAL = 7.0;
const J_AROMATIC_ORTHO = 7.8;
const J_AROMATIC_META = 1.6;
const J_ALDEHYDE = 2.4;
const J_MERGE_TOLERANCE = 0.6;
/** Couplings smaller than this are not reported by this deliberately coarse model. */
export const PROTON_COUPLING_REPORTING_THRESHOLD_HZ = 1.0;
// O–H / N–H / S–H protons are usually exchange-decoupled and don't produce observable splitting.
const LABILE_PARTNER_ELEMENTS = new Set([7, 8, 16]);

const NAMES: Record<number, string> = { 1: "d", 2: "t", 3: "q", 4: "quint", 5: "sext", 6: "sept" };

export function computeMultiplet(
  molecule: OCL.Molecule,
  hostAtom: number,
  equivalentHostAtoms: readonly number[] = [hostAtom]
): NmrMultiplet {
  molecule.ensureHelperArrays(OCL.Molecule.cHelperRings);
  const couplings: NmrCoupling[] = [];
  // Protons represented by one emitted constitutional class do not split one another in this
  // first-order display. Including the observed host also makes this explicit for any future
  // same-host (geminal) coupling path.
  const chemicallyEquivalentHosts = new Set(equivalentHostAtoms);
  chemicallyEquivalentHosts.add(hostAtom);
  const hostAromatic = molecule.isAromaticAtom(hostAtom);
  const hostAldehyde = isAldehydeCarbon(molecule, hostAtom);

  // Vicinal ³J: protons on the host's heavy neighbours (path H–C–C–H).
  for (let i = 0; i < molecule.getConnAtoms(hostAtom); i += 1) {
    const neighbor = molecule.getConnAtom(hostAtom, i);
    const partnerCount = molecule.getAllHydrogens(neighbor);
    if (
      chemicallyEquivalentHosts.has(neighbor) ||
      partnerCount <= 0 ||
      LABILE_PARTNER_ELEMENTS.has(molecule.getAtomicNo(neighbor))
    ) {
      continue;
    }
    if (hostAromatic && molecule.isAromaticAtom(neighbor)) {
      couplings.push({ jHz: J_AROMATIC_ORTHO, partnerCount, kind: "aromatic-ortho", toAtomIndex: neighbor });
    } else if (hostAldehyde || isAldehydeCarbon(molecule, neighbor)) {
      couplings.push({ jHz: J_ALDEHYDE, partnerCount, kind: "aldehyde", toAtomIndex: neighbor });
    } else {
      couplings.push({ jHz: J_VICINAL, partnerCount, kind: "vicinal", toAtomIndex: neighbor });
    }
  }

  // Aromatic ⁴J (meta): protons two ring bonds away.
  if (hostAromatic) {
    for (const meta of aromaticMetaPartners(molecule, hostAtom)) {
      if (chemicallyEquivalentHosts.has(meta)) continue;
      couplings.push({
        jHz: J_AROMATIC_META,
        partnerCount: molecule.getAllHydrogens(meta),
        kind: "aromatic-meta",
        toAtomIndex: meta
      });
    }
  }

  return buildMultiplet(couplings);
}

/**
 * Return the J value this model reports between protons on two heavy-atom hosts. A zero means that
 * this topology model has no coupling at or above its reporting threshold for the pair. Keeping
 * this pairwise form alongside `computeMultiplet()` lets magnetic-equivalence checks compare the
 * complete coupling vector rather than infer it from already-merged multiplet groups.
 */
export function reportedProtonCouplingHz(
  molecule: OCL.Molecule,
  firstHost: number,
  secondHost: number
): number {
  if (
    firstHost === secondHost ||
    molecule.getAtomicNo(firstHost) === 1 ||
    molecule.getAtomicNo(secondHost) === 1 ||
    molecule.getAllHydrogens(firstHost) <= 0 ||
    molecule.getAllHydrogens(secondHost) <= 0 ||
    LABILE_PARTNER_ELEMENTS.has(molecule.getAtomicNo(firstHost)) ||
    LABILE_PARTNER_ELEMENTS.has(molecule.getAtomicNo(secondHost))
  ) {
    return 0;
  }

  molecule.ensureHelperArrays(OCL.Molecule.cHelperRings);
  let estimated = 0;
  if (areBonded(molecule, firstHost, secondHost)) {
    if (molecule.isAromaticAtom(firstHost) && molecule.isAromaticAtom(secondHost)) {
      estimated = J_AROMATIC_ORTHO;
    } else if (isAldehydeCarbon(molecule, firstHost) || isAldehydeCarbon(molecule, secondHost)) {
      estimated = J_ALDEHYDE;
    } else {
      estimated = J_VICINAL;
    }
  } else if (
    molecule.isAromaticAtom(firstHost) &&
    molecule.isAromaticAtom(secondHost) &&
    aromaticMetaPartners(molecule, firstHost).includes(secondHost)
  ) {
    estimated = J_AROMATIC_META;
  }

  return estimated >= PROTON_COUPLING_REPORTING_THRESHOLD_HZ ? estimated : 0;
}

function areBonded(molecule: OCL.Molecule, first: number, second: number): boolean {
  for (let connection = 0; connection < molecule.getConnAtoms(first); connection += 1) {
    if (molecule.getConnAtom(first, connection) === second) return true;
  }
  return false;
}

function isAldehydeCarbon(molecule: OCL.Molecule, atom: number): boolean {
  if (molecule.getAtomicNo(atom) !== 6 || molecule.getAllHydrogens(atom) !== 1) {
    return false;
  }
  for (let i = 0; i < molecule.getConnAtoms(atom); i += 1) {
    const neighbor = molecule.getConnAtom(atom, i);
    if (molecule.getAtomicNo(neighbor) === 8 && molecule.getBondOrder(molecule.getConnBond(atom, i)) === 2) {
      return true;
    }
  }
  return false;
}

function aromaticMetaPartners(molecule: OCL.Molecule, host: number): number[] {
  const metas = new Set<number>();
  for (let i = 0; i < molecule.getConnAtoms(host); i += 1) {
    const ortho = molecule.getConnAtom(host, i);
    if (!molecule.isAromaticAtom(ortho)) {
      continue;
    }
    for (let j = 0; j < molecule.getConnAtoms(ortho); j += 1) {
      const meta = molecule.getConnAtom(ortho, j);
      if (meta !== host && molecule.isAromaticAtom(meta) && molecule.getAllHydrogens(meta) > 0) {
        metas.add(meta);
      }
    }
  }
  return [...metas];
}

/** Merge couplings with near-equal J into groups, then label by the first-order pattern. */
function buildMultiplet(couplings: readonly NmrCoupling[]): NmrMultiplet {
  const merged: NmrCoupling[] = [];
  for (const coupling of [...couplings]
    .filter((candidate) => candidate.jHz >= PROTON_COUPLING_REPORTING_THRESHOLD_HZ)
    .sort((a, b) => b.jHz - a.jHz)) {
    const existing = merged.find((m) => m.kind === coupling.kind && Math.abs(m.jHz - coupling.jHz) <= J_MERGE_TOLERANCE);
    if (existing) {
      existing.partnerCount += coupling.partnerCount;
    } else {
      merged.push({ ...coupling });
    }
  }
  if (merged.length === 0) {
    return { label: "s", couplings: [] };
  }
  merged.sort((a, b) => b.jHz - a.jHz);
  return { label: labelFor(merged), couplings: merged };
}

function labelFor(groups: readonly NmrCoupling[]): string {
  if (groups.length === 1) {
    return NAMES[groups[0].partnerCount] ?? "m";
  }
  // Compound multiplet: compact only when every group is small (d/t/q); otherwise report "m".
  const letters = groups.map((group) => (group.partnerCount <= 3 ? NAMES[group.partnerCount] : "m"));
  return letters.some((letter) => letter === "m") ? "m" : letters.join("");
}
