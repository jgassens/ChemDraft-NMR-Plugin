# GNN atom and bond features (schema 1)

On 2026-11-20 the owner decided that a per-atom graph neural network (GNN) will become the main ¹H/¹³C predictor, with the HOSE lookup kept as cross-check and fallback. The model will be retrained on features this plugin computes itself, so training and runtime share one featurizer:

- `featurizeMolecule(molecule)` and `featurizeStructure(input)` in [`src/providers/gnn/featurize.ts`](../src/providers/gnn/featurize.ts)
- the canonical dump in [`src/providers/gnn/canonicalDump.ts`](../src/providers/gnn/canonicalDump.ts)
- the parity script [`scripts/gnn-feature-parity.ts`](../scripts/gnn-feature-parity.ts)
- the tests in [`src/tests/gnnFeaturize.test.ts`](../src/tests/gnnFeaturize.test.ts)

There is no model, model runtime or UI here yet.

The featurizer is a pure function of an OpenChemLib molecule. It imports no Node-only module and never reads the clock, a random source, the locale or the platform. It never mutates the caller's molecule. The same code runs in Node (training extract) and in the plugin's Web Worker. A test checks the module sources for these dependencies.

All perception comes from the OpenChemLib version the plugin already ships (`openchemlib` 9.24.0 in `package-lock.json`). Features depend on that perception, so a parity proof holds for one OpenChemLib version. Upgrading OpenChemLib means re-running the parity check, and if the dump changes, retraining or bumping the schema.

## Molecule preparation

The steps reproduce `prepareProductionLookup` in [`productionLookup.ts`](../src/providers/ocl/productionLookup.ts), so node indices are the atom indices the HOSE path uses for the same molecule:

1. The input must be a parsed molecule: `getHelperArrayStatus() & Molecule.cHelperNeighbours` must be nonzero. `Molecule.fromMolfile`, `Molecule.fromSmiles`, `normalizeStructure` and `parseNmredataMolecule` all return one. An edited molecule must be revalidated with `ensureHelperArrays(Molecule.cHelperNeighbours)`. Otherwise the call throws `GNN_UNVALIDATED_MOLECULE`, because validating a copy could renumber atoms in the copy only.
2. `getCompactCopy()`. The copy must keep the atom and bond counts and every atom's `getAtomicNo`, `getAtomCharge` and `getAtomMass`.
3. `removeExplicitHydrogens()` removes plain hydrogens (natural abundance, uncharged, single-bonded, unlabeled). ²H, ³H and charged H stay explicit. With 2D coordinates, OpenChemLib first moves a wedge drawn to a removed H onto another bond, so the stereo configuration survives.
4. `setAtomMapNo(atom, 0, false)` on every atom. Map numbers are bookkeeping, never features.
5. `ensureHelperArrays(Molecule.cHelperRings)`.
6. Every node atom must still match the input atom at the same index (`getAtomicNo`, `getAtomCharge`, `getAtomMass`), and the heavy-atom count must be unchanged. Otherwise the call throws `GNN_ATOM_INDEX_CHANGED`.
7. `ensureHelperArrays(Molecule.cHelperParities)` for the stereo features. This level includes everything `cHelperRings` computes. If OpenChemLib's stereo perception throws, the call throws `GNN_STEREO_PERCEPTION_FAILED`.

`featurizeStructure` parses with `normalizeStructure`, the same parse the plugin's predictor uses, then calls `featurizeMolecule`.

## Nodes, edges and the index map

- **Nodes.** Every atom with `getAtomicNo(atom) !== 1`, in ascending atom index. A hydrogen bonded to at least one non-hydrogen atom is folded into that atom's hydrogen counts, whatever its isotope. Only a hydrogen with no non-hydrogen neighbor (H₂, H⁺, H⁻, a lone `[H]`) becomes a node, with the `element=H` slot set.
- **`heavyAtomIndexMap[node]`** is the atom index in the molecule passed in. Heavy-atom indices are preserved through preparation, so this is also the HOSE path's index.
- **Molfile order.** OpenChemLib moves explicit hydrogens to the end of the atom list while parsing. A heavy atom that traded places with one moves too. Node order therefore equals molfile order only when the molfile lists hydrogens after the heavy atoms. In other cases, `parseNmredataMolecule` maps molfile atom numbers to the same OpenChemLib indices. It stamps atom-map numbers, which leave the atom order unchanged. A test checks this for an interleaved molfile.
- **¹H targets.** A proton resonance is predicted on its host heavy atom's node. The host is `productionCodeAtom(molecule, "1H", hydrogen)`, and the node is `heavyAtomIndexMap.indexOf(host)`.
- **Edges.** Every bond whose two atoms are both nodes, in the prepared molecule's bond-index order, zero-order bonds included. `from` is the node of `getBondAtom(0, bond)` and `to` is the node of `getBondAtom(1, bond)`. Edges are directed only because wedge and hash bonds are: for an up or down bond, `from` is the stereo center (the narrow end).

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
| 29–32 | `atomParity=none`, `odd`, `even`, `unknown` | `getAtomParity(atom)` against `cAtomParityNone` (0), `cAtomParity1` (1), `cAtomParity2` (2), `cAtomParityUnknown` (3) | one-hot (see the stereo caveats below) |
| 33–40 | `sphere{d}PositiveCharge`, `sphere{d}NegativeCharge` for d = 1…4 | `getAtomCharge` of every node at shortest-path distance d over the edges | sum of positive charges; sum of negative-charge magnitudes; integers |

The ¹H/¹³C HOSE codes record the formal charge of every neighbor at every sphere up to `MAX_SPHERES` = 4 (see [charge-aware-hose.md](charge-aware-hose.md)). Features 33–40 give the model the same information, sphere by sphere. A test keeps `GNN_NEIGHBOR_CHARGE_SPHERES` equal to `MAX_SPHERES`. The positive and negative sums are kept apart, so a zwitterion's neighbors do not cancel to zero. The charge of a folded hydrogen is not represented.

## Bond features (15)

| Index | Name | OpenChemLib call | Encoding |
| ---: | --- | --- | --- |
| 0–4 | `order=single`, `double`, `triple`, `aromaticOrDelocalized`, `other` | `isAromaticBond(bond) \|\| isDelocalizedBond(bond) \|\| getBondTypeSimple(bond) === cBondTypeDelocalized` selects `aromaticOrDelocalized`; otherwise `getBondOrder(bond)` 1, 2 or 3; anything else (0 for metal-ligand or dative bonds, quadruple, quintuple) is `other` | one-hot. Aromatic bonds get one class whatever their Kekulé order |
| 5 | `inRing` | `isRingBond(bond)` | 0 or 1 |
| 6 | `delocalized` | `isDelocalizedBond(bond)` | 0 or 1. True in benzene and pyridine rings, false in furan, pyrrole and thiophene rings, which are still aromatic |
| 7–10 | `bondParity=none`, `1`, `2`, `unknown` | `getBondParity(bond)` against `cBondParityNone` (0), `cBondParityEor1` (1), `cBondParityZor2` (2), `cBondParityUnknown` (3) | one-hot. On a double bond, OpenChemLib's E/Z parity; on a single bond, an axial (atropisomer) parity |
| 11–14 | `stereo=none`, `up`, `down`, `cross` | `getBondType(bond) & cBondTypeMaskStereo` against 0, `cBondTypeUp & mask` (256, wedge), `cBondTypeDown & mask` (128, hash), `cBondTypeCross & mask` (384, crossed double bond) | one-hot |

## Stereo and representation caveats

- **Parities are relative to atom indices.** OpenChemLib documents that atom and bond parities depend on the indices of the neighbor atoms. The same stereoisomer written with a different atom order can therefore get the opposite parity. Both `N[C@@H](C)C(=O)O` (L-alanine) and `C[C@@H](N)C(=O)O` (D-alanine) give the stereo center `atomParity=odd`. For bonds, `C/C(F)=C/C` gets `bondParity=1` although its CIP descriptor is Z. A message-passing network cannot see the reference atom order, so these features encode *whether* a center or bond is defined more reliably than *which* configuration it has. Schema 1 uses them because the owner specified OpenChemLib parity. Order-independent descriptors (`getAtomCIPParity`, `getBondCIPParity`) are the candidate for a schema 2.
- **Wedges come from the drawing.** For a molfile, `up`, `down` and `cross` reflect the drawn bonds after the explicit-H wedge transfer in step 3. For SMILES, OpenChemLib's coordinate generation places them. The double bond in `CC=CC` reads `bondParity=unknown` and `stereo=cross`.
- **No resonance normalization.** A pentavalent nitro group (`N(=O)=O`) and the charge-separated form (`[N+](=O)[O-]`) featurize differently in charge and π count, just as their HOSE codes differ. The training corpus and the runtime input must therefore use the same drawing conventions, or a later schema must normalize them.

## Canonical dump

`buildCanonicalFeatureDump(sdText)` returns the dump text and its SHA-256. It is pure and worker-safe; SHA-256 uses Web Crypto (`crypto.subtle`), which Node 20+ and every Web Worker provide. Its rules:

- Line endings are normalized to `\n`. Records are split on `$$$$` and their molfile block extracted with `splitRecords` and `extractMolfile` from [`nmredata.ts`](../src/providers/ocl/nmredata.ts), exactly as the HOSE database compiler does.
- Each molfile is featurized with `featurizeStructure`, as `molfile-v3000` when its counts line says V3000 and as `molfile-v2000` otherwise.
- **Line 1, the header:** `{"format":"chemdraft-gnn-features","schemaVersion":"1","atomFeatures":[…41 names…],"bondFeatures":[…15 names…]}`. A change to feature names or order therefore changes the hash.
- **One line per record**, keys in this order: `index` (0-based record position), `molfileSha256` (hex SHA-256 of the extracted molfile, UTF-8), `schemaVersion`, `heavyAtomIndexMap`, `atoms`, `bonds` (each `{"from","to","features"}`).
- **Unfeaturizable records** become `{"index","molfileSha256","error"}`. The error is a stable code only: `GNN_NO_MOLFILE`, an `NMR_*` code from `normalizeStructure` (for example `NMR_STRUCTURE_PARSE_FAILED`), a `GNN_*` code from the featurizer, or `GNN_FEATURIZATION_FAILED`. Messages are never written. `molfileSha256` is `null` when there is no molfile.
- **Numbers** must be finite and exact in single precision. They print as ECMAScript `Number.prototype.toString` (the shortest decimal that round-trips, locale-independent), with −0 printed as `0`. Strings print as `JSON.stringify`. There is no whitespace, every line ends in `\n`, and the text is hashed as UTF-8.

Ethanol (`CCO`) as record 7:

```json
{"index":7,"molfileSha256":null,"schemaVersion":"1","heavyAtomIndexMap":[0,1,2],"atoms":[[0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0.75,0,0,0.25,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0],[0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0.5,0,0,0.5,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0],[0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0.25,0,0,0.25,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0]],"bonds":[{"from":0,"to":1,"features":[1,0,0,0,0,0,0,1,0,0,0,1,0,0,0]},{"from":1,"to":2,"features":[1,0,0,0,0,0,0,1,0,0,0,1,0,0,0]}]}
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
