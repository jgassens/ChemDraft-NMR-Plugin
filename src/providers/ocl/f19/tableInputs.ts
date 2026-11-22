import { Buffer } from "node:buffer";

import { median } from "./clean";

/**
 * docs/f19-benchmark.md §4 steps 2 (collapse), 3 (outlier filtering) and the GNN-training
 * exclusion that step 3 defines. Two collapses exist, keyed explicitly: HOSE tables by stereo-free
 * idcode, GNN training by stereo idcode.
 */

/** The fields a cleaned row needs for either collapse (a `CleanedRecord` satisfies it). */
export interface CollapsibleRecord {
  stereoFreeIdcode: string;
  stereoIdcode: string;
  shift: number;
  sourceKey: string;
}

/** One HOSE-table observation: one stereo-free molecule. */
export interface MoleculeObservation {
  stereoFreeIdcode: string;
  /** Median of the molecule's row shifts across all of its sources. */
  shift: number;
  /** max − min of those row shifts. */
  spread: number;
  rowCount: number;
  /** Distinct contributing source keys, byte-sorted. */
  sourceKeys: string[];
}

/** One GNN-training observation: one stereo idcode, i.e. exactly one input graph. */
export interface GnnObservation extends MoleculeObservation {
  stereoIdcode: string;
}

/** UTF-8 byte order, the order the protocol uses for keys. */
export function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

interface CollapsedGroup<R> {
  key: string;
  first: R;
  shift: number;
  spread: number;
  rowCount: number;
  sourceKeys: string[];
}

function collapseBy<R extends { shift: number; sourceKey: string }>(
  records: Iterable<R>,
  keyOf: (record: R) => string
): CollapsedGroup<R>[] {
  const byKey = new Map<string, { first: R; shifts: number[]; sourceKeys: Set<string> }>();
  for (const record of records) {
    const key = keyOf(record);
    let group = byKey.get(key);
    if (!group) byKey.set(key, (group = { first: record, shifts: [], sourceKeys: new Set() }));
    group.shifts.push(record.shift);
    group.sourceKeys.add(record.sourceKey);
  }
  return [...byKey.keys()].sort(compareBytes).map((key) => {
    const { first, shifts, sourceKeys } = byKey.get(key)!;
    return {
      key,
      first,
      shift: median(shifts),
      spread: Math.max(...shifts) - Math.min(...shifts),
      rowCount: shifts.length,
      sourceKeys: [...sourceKeys].sort(compareBytes)
    };
  });
}

/**
 * §4 step 2, HOSE tables: one observation per stereo-free idcode, so stereoisomers pool. Returned
 * in byte-sorted idcode order.
 */
export function collapseForHoseTable(
  records: Iterable<Pick<CollapsibleRecord, "stereoFreeIdcode" | "shift" | "sourceKey">>
): MoleculeObservation[] {
  return collapseBy(records, (record) => record.stereoFreeIdcode).map(({ key, shift, spread, rowCount, sourceKeys }) => ({
    stereoFreeIdcode: key,
    shift,
    spread,
    rowCount,
    sourceKeys
  }));
}

/**
 * §4 step 2, GNN training: one observation per stereo idcode, so stereoisomers stay apart. Each
 * observation also carries its stereo-free idcode, which is a function of the stereo idcode (the
 * same fragment with stereo neglected); input that maps one stereo idcode to two stereo-free
 * idcodes throws. Returned in byte-sorted stereo idcode order.
 */
export function collapseForGnnTraining(records: Iterable<CollapsibleRecord>): GnnObservation[] {
  const list = [...records];
  const stereoFreeOf = new Map<string, string>();
  for (const { stereoIdcode, stereoFreeIdcode } of list) {
    const known = stereoFreeOf.get(stereoIdcode);
    if (known === undefined) stereoFreeOf.set(stereoIdcode, stereoFreeIdcode);
    else if (known !== stereoFreeIdcode) {
      throw new Error("A stereo idcode maps to more than one stereo-free idcode.");
    }
  }
  return collapseBy(list, (record) => record.stereoIdcode).map(({ key, first, shift, spread, rowCount, sourceKeys }) => ({
    stereoIdcode: key,
    stereoFreeIdcode: first.stereoFreeIdcode,
    shift,
    spread,
    rowCount,
    sourceKeys
  }));
}

export const OUTLIER_MIN_OBSERVATIONS = 5;
export const MAD_SCALE = 1.4826;
export const SCALED_MAD_FLOOR_PPM = 1;
export const OUTLIER_SCALED_MADS = 3;

export interface OutlierObservation {
  shift: number;
  sourceKeys: readonly string[];
}

/** sphere → environment code → that environment's molecule observations at that sphere. */
export type SphereEnvironments<T> = ReadonlyMap<number, ReadonlyMap<string, readonly T[]>>;

export interface OutlierFilterResult<T> {
  kept: Map<number, Map<string, T[]>>;
  dropsBySphere: Map<number, number>;
  /** sphere → environment code → drops; only environments with at least one drop appear. */
  dropsByEnvironment: Map<number, Map<string, number>>;
  /** Each dropped observation counts once for each of its contributing source keys. */
  dropsBySourceKey: Map<string, number>;
}

/**
 * §4 step 3. Each sphere is filtered on its own, so an observation dropped from its sphere-4
 * environment stays in its sphere-3 environment unless that environment's own filtering drops it.
 * Environments with fewer than 5 observations pass through unchanged; minimum-n pruning (step 4)
 * is not applied here.
 */
export function filterOutliers<T extends OutlierObservation>(
  observationsBySphereEnvironment: SphereEnvironments<T>
): OutlierFilterResult<T> {
  const kept = new Map<number, Map<string, T[]>>();
  const dropsBySphere = new Map<number, number>();
  const dropsByEnvironment = new Map<number, Map<string, number>>();
  const dropsBySourceKey = new Map<string, number>();

  for (const [sphere, environments] of observationsBySphereEnvironment) {
    const keptAtSphere = new Map<string, T[]>();
    let sphereDrops = 0;
    for (const [environment, observations] of environments) {
      if (observations.length < OUTLIER_MIN_OBSERVATIONS) {
        keptAtSphere.set(environment, [...observations]);
        continue;
      }
      const center = median(observations.map(({ shift }) => shift));
      const mad = median(observations.map(({ shift }) => Math.abs(shift - center)));
      const scale = Math.max(MAD_SCALE * mad, SCALED_MAD_FLOOR_PPM);
      const limit = OUTLIER_SCALED_MADS * scale;
      const survivors: T[] = [];
      let environmentDrops = 0;
      for (const observation of observations) {
        if (Math.abs(observation.shift - center) > limit) {
          environmentDrops += 1;
          for (const key of new Set(observation.sourceKeys)) {
            dropsBySourceKey.set(key, (dropsBySourceKey.get(key) ?? 0) + 1);
          }
        } else {
          survivors.push(observation);
        }
      }
      keptAtSphere.set(environment, survivors);
      if (environmentDrops > 0) {
        let byEnvironment = dropsByEnvironment.get(sphere);
        if (!byEnvironment) dropsByEnvironment.set(sphere, (byEnvironment = new Map()));
        byEnvironment.set(environment, environmentDrops);
        sphereDrops += environmentDrops;
      }
    }
    kept.set(sphere, keptAtSphere);
    dropsBySphere.set(sphere, sphereDrops);
  }
  return { kept, dropsBySphere, dropsByEnvironment, dropsBySourceKey };
}

/**
 * §4 step 3, last sentence: the stereo idcodes excluded from GNN training. For each stereo-free
 * molecule, find the deepest sphere at which its environment had at least 5 observations (the
 * filter's input, i.e. the environments that were filtered); the molecule is excluded when the
 * filter dropped it there, and kept when it has no such sphere. Every GNN observation of an
 * excluded molecule is excluded. Molecules are matched by stereo-free idcode; a molecule may sit in
 * at most one environment per sphere (single-environment molecules), otherwise this throws.
 *
 * @param input the per-sphere environments handed to `filterOutliers` (stereo-free collapse)
 * @param result what `filterOutliers` returned for `input`
 * @param gnnObservations the GNN-training collapse
 * @returns excluded stereo idcodes, byte-sorted
 */
export function gnnExcludedStereoIdcodes<T extends OutlierObservation & { stereoFreeIdcode: string }>(
  input: SphereEnvironments<T>,
  result: Pick<OutlierFilterResult<T>, "kept">,
  gnnObservations: Iterable<Pick<GnnObservation, "stereoIdcode" | "stereoFreeIdcode">>
): string[] {
  /** stereo-free idcode → whether the decision has been made (true = excluded). */
  const decided = new Map<string, boolean>();
  const spheres = [...input.keys()].sort((a, b) => b - a);
  for (const sphere of spheres) {
    const environments = input.get(sphere)!;
    const keptAtSphere = result.kept.get(sphere);
    const seenAtSphere = new Set<string>();
    for (const [environment, observations] of environments) {
      for (const { stereoFreeIdcode } of observations) {
        if (seenAtSphere.has(stereoFreeIdcode)) {
          throw new Error(`A molecule appears more than once at sphere ${sphere}.`);
        }
        seenAtSphere.add(stereoFreeIdcode);
      }
      if (observations.length < OUTLIER_MIN_OBSERVATIONS) continue;
      const survivors = new Set((keptAtSphere?.get(environment) ?? []).map(({ stereoFreeIdcode }) => stereoFreeIdcode));
      for (const { stereoFreeIdcode } of observations) {
        if (!decided.has(stereoFreeIdcode)) decided.set(stereoFreeIdcode, !survivors.has(stereoFreeIdcode));
      }
    }
  }
  const excluded = new Set<string>();
  for (const { stereoIdcode, stereoFreeIdcode } of gnnObservations) {
    if (decided.get(stereoFreeIdcode) === true) excluded.add(stereoIdcode);
  }
  return [...excluded].sort(compareBytes);
}
