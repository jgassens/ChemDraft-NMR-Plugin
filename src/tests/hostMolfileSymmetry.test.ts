import type { PluginCommandContext } from "@chemdraft/plugin-api";
import { describe, expect, it } from "vitest";
import { predictSelectedStructure } from "../application/predictSelectedStructure";
import { OclHosePredictor } from "../providers/ocl/OclHosePredictor";

// Canvas-style V2000: planar coordinates, Kekule bonds, and implicit hydrogens.
const benzene = `Benzene
  ChemDraft  2D

  6  6  0  0  0  0            999 V2000
    0.0000    1.4000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    1.2124    0.7000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    1.2124   -0.7000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    0.0000   -1.4000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
   -1.2124   -0.7000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
   -1.2124    0.7000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
  1  2  2  0  0  0  0
  2  3  1  0  0  0  0
  3  4  2  0  0  0  0
  4  5  1  0  0  0  0
  5  6  2  0  0  0  0
  6  1  1  0  0  0  0
M  END`;

const naphthalene = `Naphthalene
  ChemDraft  2D

 10 11  0  0  0  0            999 V2000
   -1.2124    2.1000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    0.0000    1.4000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
   -1.2124   -0.7000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
   -2.4248    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
   -2.4248    1.4000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    1.2124    2.1000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    2.4248    1.4000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    2.4248    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    1.2124   -0.7000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
  1  2  2  0  0  0  0
  2  3  1  0  0  0  0
  3  4  2  0  0  0  0
  4  5  1  0  0  0  0
  5  6  2  0  0  0  0
  6  1  1  0  0  0  0
  2  7  1  0  0  0  0
  7  8  2  0  0  0  0
  8  9  1  0  0  0  0
  9 10  2  0  0  0  0
 10  3  1  0  0  0  0
M  END`;

// Add an explicit H to the first carbon, retaining implicit H on the other carbons.
const explicitH = benzene.replace("  6  6  0", "  7  7  0")
  .replace("  1  2  2  0", "    0.0000    2.4000    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0\n  1  2  2  0")
  .replace("M  END", "  1  7  1  0  0  0  0\nM  END");

function reverseAtoms(molfile: string): string {
  const lines = molfile.split("\n");
  const atoms = Number(lines[3].slice(0, 3));
  const bonds = Number(lines[3].slice(3, 6));
  const atomLines = lines.slice(4, 4 + atoms).reverse();
  const bondLines = lines.slice(4 + atoms, 4 + atoms + bonds).map((line) => {
    const a = atoms + 1 - Number(line.slice(0, 3));
    const b = atoms + 1 - Number(line.slice(3, 6));
    return `${String(a).padStart(3)}${String(b).padStart(3)}${line.slice(6)}`;
  });
  return [...lines.slice(0, 4), ...atomLines, ...bondLines, ...lines.slice(4 + atoms + bonds)].join("\n");
}

async function predict(molfile: string) {
  const molecule = { objectId: "m1", structureFormat: "molfile-v2000", structure: molfile, sourceFingerprint: "fp" };
  const context = {
    selection: { getSelection: async () => ({ objectIds: ["m1"], molecules: [molecule] }) },
    analysis: { write: async () => ({}) }
  } as unknown as PluginCommandContext;
  const result = await predictSelectedStructure(context, { predictor: new OclHosePredictor() }, { nuclei: ["1H", "13C"] });
  if (!result.ok) throw new Error(result.error.message);
  return result.data.resonances;
}

describe("host V2000 aromatic symmetry", () => {
  it.each([["implicit H", benzene], ["explicit H", explicitH], ["reversed atoms", reverseAtoms(benzene)]])
  ("groups benzene with %s", async (_name, molfile) => {
    const resonances = await predict(molfile);
    const protons = resonances.filter((r) => r.nucleus === "1H");
    const carbons = resonances.filter((r) => r.nucleus === "13C");
    expect(protons).toHaveLength(1);
    expect(protons[0].equivalentNuclei).toBe(6);
    expect(protons[0].multiplet?.label).toBe("s");
    expect(carbons).toHaveLength(1);
    expect(carbons[0].equivalentNuclei).toBe(6);
    expect(protons[0].deltaPpm).toBeGreaterThanOrEqual(7);
    expect(protons[0].deltaPpm).toBeLessThanOrEqual(8);
    expect(carbons[0].deltaPpm).toBeGreaterThanOrEqual(120);
    expect(carbons[0].deltaPpm).toBeLessThanOrEqual(140);
  });

  it.each([["original", naphthalene], ["reversed atoms", reverseAtoms(naphthalene)]])
  ("groups naphthalene with %s", async (_name, molfile) => {
    const resonances = await predict(molfile);
    const protons = resonances.filter (r => r.nucleus === "1H");
    const carbons = resonances.filter (r => r.nucleus === "13C");
    expect(protons.map(r => r.equivalentNuclei).sort()).toEqual([4, 4]);
    expect(carbons.map(r => r.equivalentNuclei).sort()).toEqual([2, 4, 4]);
    for (const r of protons) expect(r.deltaPpm).toBeGreaterThanOrEqual(7), expect(r.deltaPpm).toBeLessThanOrEqual(8);
    for (const r of carbons) expect(r.deltaPpm).toBeGreaterThanOrEqual(120), expect(r.deltaPpm).toBeLessThanOrEqual(140);
  });
});
