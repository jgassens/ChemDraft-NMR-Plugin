import { Buffer } from "node:buffer";

import { median } from "./clean";

/** docs/f19-benchmark.md §4 table-input steps 2 (molecule collapse) and 3 (outlier filtering). */

export interface CollapsibleRecord {
  idcode: string;
  shift: number;
  sourceKey: string;
}

export interface MoleculeObservation {
  idcode: string;
  /** Median of the molecule's row shifts across all of its sources. */
  shift: number;
  /** max − min of those row shifts. */
  spread: number;
  rowCount: number;
  /** Distinct contributing source keys, byte-sorted. */
  sourceKeys: string[];
}

/** UTF-8 byte order, the order the protocol uses for keys. */
export function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** §4 step 2: one observation per idcode, returned in byte-sorted idcode order. */
export function collapseMolecules(records: Iterable<CollapsibleRecord>): MoleculeObservation[] {
  const byIdcode = new Map<string, { shifts: number[]; sourceKeys: Set<string> }>();
  for (const { idcode, shift, sourceKey } of records) {
    let group = byIdcode.get(idcode);
    if (!group) byIdcode.set(idcode, (group = { shifts: [], sourceKeys: new Set() }));
    group.shifts.push(shift);
    group.sourceKeys.add(sourceKey);
  }
  return [...byIdcode.keys()].sort(compareBytes).map((idcode) => {
    const { shifts, sourceKeys } = byIdcode.get(idcode)!;
    return {
      idcode,
      shift: median(shifts),
      spread: Math.max(...shifts) - Math.min(...shifts),
      rowCount: shifts.length,
      sourceKeys: [...sourceKeys].sort(compareBytes)
    };
  });
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
