# GNN atom and bond features (schema 1)

On 2026-11-20 the owner decided that a per-atom graph neural network (GNN) will become the main ¹H/¹³C predictor, with the HOSE lookup kept as cross-check and fallback. The model will be retrained on features this plugin computes itself, so training and runtime share one featurizer:

- `featurizeMolecule(molecule)` and `featurizeStructure(input)` in [`src/providers/gnn/featurize.ts`](../src/providers/gnn/featurize.ts)
- the canonical dump in [`src/providers/gnn/canonicalDump.ts`](../src/providers/gnn/canonicalDump.ts)
- the parity script [`scripts/gnn-feature-parity.ts`](../scripts/gnn-feature-parity.ts)
- the tests in [`src/tests/gnnFeaturize.test.ts`](../src/tests/gnnFeaturize.test.ts)

There is no model, model runtime or UI here yet.

The featurizer is a pure function of an OpenChemLib molecule. It imports no Node-only module and never reads the clock, a random source, the locale or the platform. It never mutates the caller's molecule. The same code runs in Node (training extract) and in the plugin's Web Worker. A test checks the module sources for these dependencies.

All perception comes from the OpenChemLib version the plugin already ships (`openchemlib` 9.24.0 in `package-lock.json`). Features depend on that perception, so a parity proof holds for one OpenChemLib version. In particular, the R/S and E/Z labels are OpenChemLib 9.24.0's Cahn-Ingold-Prelog (CIP) perception, which is not guaranteed to match another toolkit or another OpenChemLib release on hard cases. Upgrading OpenChemLib means re-running the parity check (and the stereo tests, which pin 9.24.0's labels), and if the dump changes, retraining or bumping the schema.

## Molecule preparation

The steps reproduce `prepareProductionLookup` in [`productionLookup.ts`](../src/providers/ocl/productionLookup.ts), so node indices are the atom indices the HOSE path uses for the same molecule:

1. The input must be a parsed molecule: `getHelperArrayStatus() & Molecule.cHelperNeighbours` must be nonzero. `Molecule.fromMolfile`, `Molecule.fromSmiles`, `normalizeStructure` and `parseNmredataMolecule` all return one. An edited molecule must be revalidated with `ensureHelperArrays(Molecule.cHelperNeighbours)`. Otherwise the call throws `GNN_UNVALIDATED_MOLECULE`, because validating a copy could renumber atoms in the copy only.
2. `getCompactCopy()`. The copy must keep the atom and bond counts and every atom's `getAtomicNo`, `getAtomCharge` and `getAtomMass`.
3. `removeExplicitHydrogens()` removes plain hydrogens (natural abundance, uncharged, single-bonded, unlabeled). ²H, ³H and charged H stay explicit. With 2D coordinates, OpenChemLib first moves a wedge drawn to a removed H onto another bond, so the stereo configuration survives.
4. `setAtomMapNo(atom, 0, false)` on every atom. Map numbers are bookkeeping, never features.
5. `ensureHelperArrays(Molecule.cHelperRings)`.
6. Every node atom must still match the input atom at the same index (`getAtomicNo`, `getAtomCharge`, `getAtomMass`), and the heavy-atom count must be unchanged. Otherwise the call throws `GNN_ATOM_INDEX_CHANGED`.
7. `ensureHelperArrays(Molecule.cHelperCIP)` for the stereo features. This level (31) includes everything `cHelperRings` (7) and `cHelperParities` (15) compute, so `getAtomParity` / `getBondParity` are valid as well as `getAtomCIPParity` / `getBondCIPParity`. It runs on the prepared molecule, after the wedge transfer in step 3, so a center drawn through an explicit H keeps its R/S. If OpenChemLib's stereo perception throws, the call throws `GNN_STEREO_PERCEPTION_FAILED`.

`featurizeStructure` parses with `normalizeStructure`, the same parse the plugin's predictor uses, then calls `featurizeMolecule`.

## Nodes, edges and the index map

- **Nodes.** Every atom with `getAtomicNo(atom) !== 1`, in ascending atom index. A hydrogen bonded to at least one non-hydrogen atom is folded into that atom's hydrogen counts, whatever its isotope. Only a hydrogen with no non-hydrogen neighbor (H₂, H⁺, H⁻, a lone `[H]`) becomes a node, with the `element=H` slot set.
- **`heavyAtomIndexMap[node]`** is the atom index in the molecule passed in. Heavy-atom indices are preserved through preparation, so this is also the HOSE path's index.
- **Molfile order.** OpenChemLib moves explicit hydrogens to the end of the atom list while parsing. A heavy atom that traded places with one moves too. Node order therefore equals molfile order only when the molfile lists hydrogens after the heavy atoms. In other cases, `parseNmredataMolecule` maps molfile atom numbers to the same OpenChemLib indices. It stamps atom-map numbers, which leave the atom order unchanged. A test checks this for an interleaved molfile.
- **¹H targets.** A proton resonance is predicted on its host heavy atom's node. The host is `productionCodeAtom(molecule, "1H", hydrogen)`, and the node is `heavyAtomIndexMap.indexOf(host)`.
- **Edges.** Every bond whose two atoms are both nodes, in the prepared molecule's bond-index order, zero-order bonds included. `from` is the node of `getBondAtom(0, bond)` and `to` is the node of `getBondAtom(1, bond)`. No feature depends on which end is `from`, so edges are effectively undirected; a model should treat them so (add both directions for message passing).

## Encoding rule

Every value is an integer or a multiple of 1/8, small enough to be exact in IEEE single precision. `Float32Array.from(row)` is lossless. Counts use fixed power-of-two divisors and are never clipped, except the ring size. The featurizer throws `GNN_NON_FLOAT32_FEATURE` if any value is not exact in single precision.

## Atom features (41)

All calls are `OCL.Molecule` methods on the prepared molecule, and `atom` is the node's atom index.

| Index | Name | OpenChemLib call | Encoding |
| ---: | --- | --- | --- |
| 0–13 | `element=H`, `B`, `C`, `N`, `O`, `F`, `Si`, `P`, `S`, `Cl`, `Se`, `Br`, `I`, `other` | `getAtomicNo(atom)` | one-hot over atomic numbers 1, 5, 6, 7, 8, 9, 14, 15, 16, 17, 34, 35, 53; anything else sets `other` |
| 14 | `formalCharge` | `getAtomCharge(atom)` | integer, unscaled |
| 15–18 | `radical=none`, `singlet`, `doublet`, `triplet` | `getAtomRadical(atom)` against `cAtomRadicalStateNone` (0), `cAtomRadicalStateS` (16), `cAtomRadicalStateD` (32), `cAtomRadicalStateT` (48) | one-hot |
| 19 | `isotopeLabeled` | `getAtomMass(atom) !== 0` | 0 or 1 |
| 20 | `isotopeMassDelta` | `getAtomMass(atom) - Molecule.cRoundedMass[getAtomicNo(atom)]`, or 0 when `getAtomMass(atom)` is 0 | integer (¹³C: 1, ¹⁸O: 2) |
| 21 | `totalHydrogens/4` | `getAllHydrogens(atom)` | ÷ 4. Implicit plus every explicit hydrogen neighbor of any isotope; the HOSE `h` count |
| 22 | `attachedDeuterium/4` | bonds (`getBondAtom`) to a folded hydrogen with `getAtomMass` 2 | ÷ 4 |
| 23 | `attachedTritium/4` | bonds to a folded hydrogen with `getAtomMass` 3 | ÷ 4 |
| 24 | `heavyDegree/4` | bonds (`getAllBonds`, `getBondAtom`) to an atom with `getAtomicNo` ≠ 1, any bond order | ÷ 4 |
| 25 | `piElectrons/2` | `getAtomPi(atom)` | ÷ 2. The hybridization proxy: π electrons at the atom, roughly 0 for sp³, 1 for sp², 2 for sp or cumulated centers |
| 26 | `aromatic` | `isAromaticAtom(atom)` | 0 or 1 |
| 27 | `inRing` | `isRingAtom(atom)` | 0 or 1 |
| 28 | `smallestRingSize/8` | `getAtomRingSize(atom)` | `min(size, 8) / 8`. 0 outside rings; every ring of 8 or more atoms reads 1 |
| 29–32 | `atomCIP=none`, `R`, `S`, `unknown` | `getAtomCIPParity(atom)` and `getAtomParity(atom)`; see [Stereo features](#stereo-features) | one-hot |
| 33–40 | `sphere{d}PositiveCharge`, `sphere{d}NegativeCharge` for d = 1…4 | `getAtomCharge` of every node at shortest-path distance d over the edges | sum of positive charges; sum of negative-charge magnitudes; integers |

The ¹H/¹³C HOSE codes record the formal charge of every neighbor at every sphere up to `MAX_SPHERES` = 4 (see [charge-aware-hose.md](charge-aware-hose.md)). Features 33–40 are related to that information but are not equivalent to it. Each node is counted once, at its shortest-path distance from the atom, over the edges of the graph, and edges include every bond, order-0 (dative or coordination) bonds among them. The HOSE encoder walks `getConnAtoms`, which excludes order-0 bonds, and it emits ring-closure revisits. So (1) charged atoms reached only through a metal-ligand bond are placed in a sphere here but are absent or placed differently in the HOSE code, and (2) ring charges can fall in different spheres or carry different multiplicity, because HOSE revisits a ring atom and these features count it once. A test keeps `GNN_NEIGHBOR_CHARGE_SPHERES` equal to `MAX_SPHERES`. The positive and negative sums are kept apart, so a zwitterion's neighbors do not cancel to zero. The charge of a folded hydrogen is not represented.

## Bond features (11)

| Index | Name | OpenChemLib call | Encoding |
| ---: | --- | --- | --- |
| 0–4 | `order=single`, `double`, `triple`, `aromaticOrDelocalized`, `other` | `isAromaticBond(bond) \|\| isDelocalizedBond(bond) \|\| getBondTypeSimple(bond) === cBondTypeDelocalized` selects `aromaticOrDelocalized`; otherwise `getBondOrder(bond)` 1, 2 or 3; anything else (0 for metal-ligand or dative bonds, quadruple, quintuple) is `other` | one-hot. Aromatic bonds get one class whatever their Kekulé order |
| 5 | `inRing` | `isRingBond(bond)` | 0 or 1 |
| 6 | `delocalized` | `isDelocalizedBond(bond)` | 0 or 1. True in benzene and pyridine rings, false in furan, pyrrole and thiophene rings, which are still aromatic |
| 7–10 | `bondCIP=none`, `E`, `Z`, `unknown` | `getBondCIPParity(bond)` and `getBondParity(bond)`; see [Stereo features](#stereo-features) | one-hot |

## Stereo features

Schema 1 encodes configuration with Cahn-Ingold-Prelog descriptors, which do not depend on atom numbering. An earlier draft of schema 1 used `getAtomParity` / `getBondParity` and wedge/hash bond types; it was replaced on 2026-11-20, before any model was trained on these features, because those values are relative to atom indices or to the drawing (see [Why not OpenChemLib parity](#why-not-openchemlib-parity)).

Both groups are computed on the prepared molecule after `ensureHelperArrays(Molecule.cHelperCIP)` (step 7):

**Atom, indices 29–32.** With `cip = getAtomCIPParity(atom)`:

| Slot | Condition |
| --- | --- |
| `atomCIP=R` | `cip === Molecule.cAtomCIPParityRorM` (1) |
| `atomCIP=S` | `cip === Molecule.cAtomCIPParitySorP` (2) |
| `atomCIP=unknown` | otherwise, when `getAtomParity(atom) !== Molecule.cAtomParityNone` (0) or `cip !== Molecule.cAtomCIPParityNone` (0) |
| `atomCIP=none` | otherwise: not a stereo atom |

**Bond, indices 7–10.** With `cip = getBondCIPParity(bond)`:

| Slot | Condition |
| --- | --- |
| `bondCIP=E` | `cip === Molecule.cBondCIPParityEorP` (1) |
| `bondCIP=Z` | `cip === Molecule.cBondCIPParityZorM` (2) |
| `bondCIP=unknown` | otherwise, when `getBondParity(bond) !== Molecule.cBondParityNone` (0) or `cip !== Molecule.cBondCIPParityNone` (0) |
| `bondCIP=none` | otherwise: not a stereo bond |

Only *whether* `getAtomParity` / `getBondParity` is nonzero is read, which does not depend on numbering; their odd/even value, which does, is never used. What the slots mean in practice, as observed with OpenChemLib 9.24.0. The tests pin the alanine, E/Z, undefined-stereo, meso and 1,4-dimethylcyclohexane cases; the sulfoxide, ammonium, cyclobutane, allene, atropisomer and ESR observations come from a one-off probe and are not pinned:

- **Defined centers and double bonds.** L-alanine reads S however the SMILES or molfile is written (`N[C@@H](C)C(=O)O`, `C[C@H](N)C(=O)O`, a wedge or hash drawing); D-alanine reads R. `C/C(F)=C/C` reads Z and `C/C=C/C` reads E. Sulfoxides, chiral ammonium ions and other stereo heteroatoms OpenChemLib perceives get R/S the same way.
- **Undefined stereo reads `unknown`.** An undrawn stereocenter (`NC(C)C(=O)O`, a molfile without a wedge), an unspecified double bond (`CC=CC`) and a crossed double bond (molfile bond stereo 3) set `unknown`, never `none`.
- **`unknown` also covers configurations CIP cannot name.** The relative cis/trans configuration of 1,4-disubstituted cyclohexanes and 1,3-disubstituted cyclobutanes has no R/S label in OpenChemLib (`getAtomCIPParity` is 0, `isAtomParityPseudo` is true). Both ring centers read `unknown`, so cis, trans and unspecified are **indistinguishable** in schema 1. A CIP "problem" (`cAtomCIPParityProblem`, `cBondCIPParityProblem`, 3) also reads `unknown`.
- **Pseudo-asymmetric centers** (r/s, for example C3 of a meso 2,4-disubstituted pentan-3-ol) get their lowercase label in the R/S slot of the same letter.
- **Axial chirality** shares the slots, following OpenChemLib's constant names: an allene's central atom puts M in `R` and P in `S`; an atropisomeric (BINAP-type) single bond puts P in `E` and M in `Z`. An undefined axis reads `unknown`.
- **Enhanced stereo (ESR) is not represented.** AND/OR groups and the molfile chiral flag do not change the label: an `&1` (racemic) or `or1` center gets the R/S of the drawn configuration.

**No wedge or hash features.** Up, down and crossed bond types are drawing artifacts: the same stereoisomer can be drawn with a wedge on a different bond, a hash instead of a wedge on the opposite side, or (from SMILES) with whatever wedge OpenChemLib's coordinate generation places. A network without coordinates cannot interpret them, and they would make enantiomers differ on bonds away from the center. Their stereo content is carried by the CIP slots: a crossed double bond reads `bondCIP=unknown`.

### Why not OpenChemLib parity

OpenChemLib's atom and bond parities depend on the indices of the neighbor atoms. Both `N[C@@H](C)C(=O)O` (L-alanine) and `C[C@@H](N)C(=O)O` (D-alanine) give the stereo center `getAtomParity` 1 ("odd"), and `C/C(F)=C/C` gets `getBondParity` 1 (`cBondParityEor1`) although it is Z. A message-passing network cannot see the reference atom order, so parity only told it that a center was defined. The tests check that features no longer depend on atom order: each test molecule is rewritten with its molfile atoms and bonds in three other orders (verified to be the same stereoisomer by ID code), and the atom rows and edges must be the same multisets. With parity restored in place of CIP, those tests fail.

(OpenChemLib's own API comment on `getAtomCIPParity` and `getBondCIPParity` repeats the "depends on the atom indices" sentence from the parity methods. The returned descriptors do not depend on numbering, as the reordering tests show.)

## Representation caveats

- **Stereo coverage is not complete.** Relative ring cis/trans configurations and undefined stereo both read `unknown`, and ESR groups are not represented, so schema 1 is not complete stereochemical coverage (see [Stereo features](#stereo-features)).
- **No resonance normalization.** A pentavalent nitro group (`N(=O)=O`) and the charge-separated form (`[N+](=O)[O-]`) featurize differently in charge and π count, just as their HOSE codes differ. The training corpus and the runtime input must therefore use the same drawing conventions, or a later schema must normalize them.

## Canonical dump

`buildCanonicalFeatureDump(sdText)` returns the dump text and its SHA-256. It is pure and worker-safe; SHA-256 uses Web Crypto (`crypto.subtle`), which Node 20+ and every Web Worker provide. Its rules:

- Line endings are normalized to `\n`. Records are split on `$$$$` and their molfile block extracted with `splitRecords` and `extractMolfile` from [`nmredata.ts`](../src/providers/ocl/nmredata.ts), exactly as the HOSE database compiler does.
- Each molfile is featurized with `featurizeStructure`, as `molfile-v3000` when its counts line says V3000 and as `molfile-v2000` otherwise.
- **Line 1, the header:** `{"format":"chemdraft-gnn-features","schemaVersion":"1","atomFeatures":[…41 names…],"bondFeatures":[…11 names…]}`. A change to feature names or order therefore changes the hash.
- **One line per record**, keys in this order: `index` (0-based record position), `molfileSha256` (hex SHA-256 of the extracted molfile, UTF-8), `schemaVersion`, `heavyAtomIndexMap`, `atoms`, `bonds` (each `{"from","to","features"}`).
- **Unfeaturizable records** become `{"index","molfileSha256","error"}`. The error is a stable code only: `GNN_NO_MOLFILE`, an `NMR_*` code from `normalizeStructure` (for example `NMR_STRUCTURE_PARSE_FAILED`), a `GNN_*` code from the featurizer, or `GNN_FEATURIZATION_FAILED`. Messages are never written. `molfileSha256` is `null` when there is no molfile.
- **Numbers** must be finite and exact in single precision. They print as ECMAScript `Number.prototype.toString` (the shortest decimal that round-trips, locale-independent), with −0 printed as `0`. Strings print as `JSON.stringify`. There is no whitespace, every line ends in `\n`, and the text is hashed as UTF-8.

Ethanol (`CCO`) as record 7:

```json
{"index":7,"molfileSha256":null,"schemaVersion":"1","heavyAtomIndexMap":[0,1,2],"atoms":[[0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0.75,0,0,0.25,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0],[0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0.5,0,0,0.5,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0],[0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0.25,0,0,0.25,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0]],"bonds":[{"from":0,"to":1,"features":[1,0,0,0,0,0,0,1,0,0,0]},{"from":1,"to":2,"features":[1,0,0,0,0,0,0,1,0,0,0]}]}
```

(The real dump fills `molfileSha256`; this line comes from a SMILES input, which has no molfile.)

## Proving training and worker parity

```sh
node --import tsx scripts/gnn-feature-parity.ts corpus.sd features.jsonl
# writes features.jsonl and features.jsonl.sha256 (shasum -a 256 format), prints
# {"sha256":"…","bytes":…,"records":…,"featurized":…,"errors":…}

node --import tsx scripts/gnn-feature-parity.ts corpus.sd features.jsonl --expect-sha256 <hex>
# exits 2 when the hash differs
```

The script only reads and writes files; the dump comes from `buildCanonicalFeatureDump`, the function the worker runs. To prove parity, run `buildCanonicalFeatureDump` on the same SD text inside the plugin worker and compare its `sha256` with the script's, or pass the worker's hash to `--expect-sha256`. Alternatively, compare individual records with `featurizeStructure` and `canonicalFeatureLine`.

The tests already check three paths against the direct call:

- the plugin's worker message handler (`createNmrWorkerHandler`, with structured cloning);
- a separate Node worker thread;
- the script itself.

All three give the same bytes. The training extract should featurize through this dump, or through `featurizeMolecule` on `parseNmredataMolecule(…).molecule`. A test checks that this gives the same features as the plugin parse, so assignments map through `oclAtomByMolfileIndex` and `heavyAtomIndexMap`.
