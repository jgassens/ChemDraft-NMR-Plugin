/**
 * ONNX input tensors for one molecule, built from the schema-1 features exactly as the training code
 * packs them (`nmr-model-experiment/py/featurize.py`, `graph` and `pack`, commit c05b91c):
 *
 * - `atoms`    float32 [1, N, 41]: the node feature rows, in node order.
 * - `neighbor` int32   [1, N, D]: for each node, the destination node of each incident edge. The
 *   edge lists are filled by walking `features.bonds` in order and appending `to` to `from`'s list
 *   and then `from` to `to`'s list (both directions; the plugin's edges are undirected).
 * - `bonds`    float32 [1, N, D, 11]: the bond feature row of each listed edge.
 * - `mask`     bool    [1, N, D]: true for a listed edge, false for padding.
 *
 * D is the largest node degree (at least 1). The training buckets pad N and D further (to powers of
 * two); padding never reaches a real node (padded slots are masked out and no real node lists a
 * padded node), so N and D are not padded here, as in the experiment's exported latency inputs.
 * The model's output `ppm` is [1, N]: a de-normalized shift prediction for every node.
 *
 * Pure and worker-safe.
 */
import { GNN_ATOM_FEATURE_COUNT, GNN_BOND_FEATURE_COUNT, type GnnMoleculeFeatures } from "./featurize";

export interface GnnInputTensors {
  /** N: graph nodes. */
  atomCount: number;
  /** D: neighbor slots per node. */
  degree: number;
  atoms: Float32Array;
  neighbor: Int32Array;
  bonds: Float32Array;
  /** 0/1 bytes; the ONNX `bool` tensor's data. */
  mask: Uint8Array;
}

export class GnnTensorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GnnTensorError";
  }
}

export function packGnnInputs(features: GnnMoleculeFeatures): GnnInputTensors {
  const atomCount = features.atoms.length;
  if (atomCount === 0) throw new GnnTensorError("A molecule needs at least one graph node.");
  if (features.heavyAtomIndexMap.length !== atomCount) throw new GnnTensorError("The node map does not match the atoms.");
  for (const row of features.atoms) {
    if (row.length !== GNN_ATOM_FEATURE_COUNT) throw new GnnTensorError("An atom row does not match the schema.");
  }
  const lists: { destination: number; features: readonly number[] }[][] = features.atoms.map(() => []);
  for (const bond of features.bonds) {
    const { from, to } = bond;
    if (
      !Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= atomCount || to >= atomCount ||
      bond.features.length !== GNN_BOND_FEATURE_COUNT
    ) {
      throw new GnnTensorError("A bond does not match the graph or the schema.");
    }
    lists[from].push({ destination: to, features: bond.features });
    lists[to].push({ destination: from, features: bond.features });
  }
  const degree = Math.max(1, ...lists.map((edges) => edges.length));
  const atoms = new Float32Array(atomCount * GNN_ATOM_FEATURE_COUNT);
  features.atoms.forEach((row, node) => atoms.set(row, node * GNN_ATOM_FEATURE_COUNT));
  const neighbor = new Int32Array(atomCount * degree);
  const bonds = new Float32Array(atomCount * degree * GNN_BOND_FEATURE_COUNT);
  const mask = new Uint8Array(atomCount * degree);
  lists.forEach((edges, node) => {
    edges.forEach((edge, slot) => {
      const position = node * degree + slot;
      neighbor[position] = edge.destination;
      bonds.set(edge.features, position * GNN_BOND_FEATURE_COUNT);
      mask[position] = 1;
    });
  });
  return { atomCount, degree, atoms, neighbor, bonds, mask };
}

/** Tensor shapes in ONNX input order (`atoms`, `neighbor`, `bonds`, `mask`). */
export function gnnInputShapes(inputs: GnnInputTensors): Record<"atoms" | "neighbor" | "bonds" | "mask", number[]> {
  const { atomCount: n, degree: d } = inputs;
  return {
    atoms: [1, n, GNN_ATOM_FEATURE_COUNT],
    neighbor: [1, n, d],
    bonds: [1, n, d, GNN_BOND_FEATURE_COUNT],
    mask: [1, n, d]
  };
}
