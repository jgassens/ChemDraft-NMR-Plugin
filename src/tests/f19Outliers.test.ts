import { describe, expect, it } from "vitest";

import {
  collapseForGnnTraining,
  collapseForHoseTable,
  filterOutliers,
  gnnExcludedStereoIdcodes,
  type OutlierObservation,
  type SphereEnvironments
} from "../providers/ocl/f19";

interface Obs extends OutlierObservation {
  idcode: string;
}

function obs(idcode: string, shift: number, sourceKeys: string[] = [`src-${idcode}`]): Obs {
  return { idcode, shift, sourceKeys };
}

function ids(observations: readonly Obs[] | undefined): string[] {
  return (observations ?? []).map(({ idcode }) => idcode);
}

function row(stereoFreeIdcode: string, stereoIdcode: string, shift: number, sourceKey: string) {
  return { stereoFreeIdcode, stereoIdcode, shift, sourceKey };
}

describe("collapseForHoseTable (§4 step 2, stereo-free)", () => {
  it("collapses rows to one observation per stereo-free idcode with median, spread, count and sorted sources", () => {
    const result = collapseForHoseTable([
      { stereoFreeIdcode: "b", shift: -60, sourceKey: "paper-z" },
      { stereoFreeIdcode: "a", shift: -120, sourceKey: "paper-y" },
      { stereoFreeIdcode: "b", shift: -64, sourceKey: "paper-x" },
      { stereoFreeIdcode: "b", shift: -61, sourceKey: "paper-z" },
      { stereoFreeIdcode: "a", shift: -121, sourceKey: "paper-x" }
    ]);
    expect(result).toEqual([
      { stereoFreeIdcode: "a", shift: -120.5, spread: 1, rowCount: 2, sourceKeys: ["paper-x", "paper-y"] },
      { stereoFreeIdcode: "b", shift: -61, spread: 4, rowCount: 3, sourceKeys: ["paper-x", "paper-z"] }
    ]);
  });

  it("uses the even-count median and byte order for keys", () => {
    const [only] = collapseForHoseTable([
      { stereoFreeIdcode: "a", shift: 1, sourceKey: "b" },
      { stereoFreeIdcode: "a", shift: 2, sourceKey: "B" },
      { stereoFreeIdcode: "a", shift: 3, sourceKey: "a" },
      { stereoFreeIdcode: "a", shift: 10, sourceKey: "a" }
    ]);
    expect(only.shift).toBe(2.5);
    expect(only.spread).toBe(9);
    expect(only.rowCount).toBe(4);
    expect(only.sourceKeys).toEqual(["B", "a", "b"]);
  });

  it("pools stereoisomers into one observation", () => {
    const result = collapseForHoseTable([
      row("m", "m-E", -100, "p1"),
      row("m", "m-Z", -110, "p2"),
      row("m", "m-Z", -112, "p2")
    ]);
    expect(result).toEqual([{ stereoFreeIdcode: "m", shift: -110, spread: 12, rowCount: 3, sourceKeys: ["p1", "p2"] }]);
  });
});

describe("collapseForGnnTraining (§4 step 2, stereo)", () => {
  it("keeps stereoisomers apart: one observation per stereo idcode, carrying its stereo-free idcode", () => {
    const result = collapseForGnnTraining([
      row("m", "m-Z", -110, "p2"),
      row("m", "m-E", -100, "p1"),
      row("m", "m-Z", -112, "p3"),
      row("m", "m-Z", -111, "p2"),
      row("n", "n", -60, "p1")
    ]);
    expect(result).toEqual([
      { stereoIdcode: "m-E", stereoFreeIdcode: "m", shift: -100, spread: 0, rowCount: 1, sourceKeys: ["p1"] },
      { stereoIdcode: "m-Z", stereoFreeIdcode: "m", shift: -111, spread: 2, rowCount: 3, sourceKeys: ["p2", "p3"] },
      { stereoIdcode: "n", stereoFreeIdcode: "n", shift: -60, spread: 0, rowCount: 1, sourceKeys: ["p1"] }
    ]);
  });

  it("uses the even-count median and byte order for stereo idcodes and source keys", () => {
    const result = collapseForGnnTraining([
      row("m", "b", 1, "y"),
      row("m", "b", 4, "Y"),
      row("m", "B", 0, "x")
    ]);
    expect(result.map(({ stereoIdcode }) => stereoIdcode)).toEqual(["B", "b"]);
    expect(result[1]).toMatchObject({ shift: 2.5, spread: 3, rowCount: 2, sourceKeys: ["Y", "y"] });
  });

  it("refuses a stereo idcode with two stereo-free idcodes", () => {
    expect(() => collapseForGnnTraining([row("m", "s", 1, "p"), row("n", "s", 1, "p")])).toThrow();
  });
});

describe("filterOutliers (§4 step 3)", () => {
  it("filters each sphere independently", () => {
    const outlier = obs("x", 30);
    const near = [obs("a", 10), obs("b", 10.5), obs("c", 9.5), obs("d", 10.2), obs("e", 9.8)];
    // Sphere 4: the outlier sits among tight neighbors and is dropped. Sphere 3: the same
    // observation sits in a wide environment and survives.
    const wide = [obs("f", 20), obs("g", 40), obs("h", 25), obs("i", 35), obs("j", 30.5)];
    const result = filterOutliers(
      new Map([
        [4, new Map([["env4", [...near, outlier]]])],
        [3, new Map([["env3", [...wide, outlier]]])]
      ])
    );
    expect(ids(result.kept.get(4)?.get("env4"))).toEqual(["a", "b", "c", "d", "e"]);
    expect(ids(result.kept.get(3)?.get("env3"))).toContain("x");
    expect(result.dropsBySphere.get(4)).toBe(1);
    expect(result.dropsBySphere.get(3)).toBe(0);
    expect(result.dropsByEnvironment.get(4)?.get("env4")).toBe(1);
    expect(result.dropsByEnvironment.has(3)).toBe(false);
  });

  it("floors the scaled MAD at 1 ppm and drops only beyond 3 scaled MADs", () => {
    const base = [obs("a", 10), obs("b", 10), obs("c", 10), obs("d", 10)];
    const run = (shift: number) =>
      filterOutliers(new Map([[2, new Map([["env", [...base, obs("x", shift)]]])]]));
    // MAD is 0, so without the floor every deviation would drop.
    expect(ids(run(12.9).kept.get(2)?.get("env"))).toContain("x");
    expect(ids(run(13).kept.get(2)?.get("env"))).toContain("x"); // exactly 3 scaled MADs: kept
    expect(ids(run(13.1).kept.get(2)?.get("env"))).not.toContain("x");
    expect(ids(run(6.9).kept.get(2)?.get("env"))).not.toContain("x");
  });

  it("uses 1.4826 × MAD when it exceeds the floor", () => {
    // Median 10, absolute deviations 0, 1, 1, 2, 2 → MAD 1 → scaled 1.4826 → limit 4.4478.
    const environment = (shift: number) => [obs("a", 10), obs("b", 9), obs("c", 11), obs("d", 8), obs("x", shift)];
    const keptAt = (shift: number) =>
      ids(filterOutliers(new Map([[1, new Map([["env", environment(shift)]])]])).kept.get(1)?.get("env"));
    expect(keptAt(14.44)).toContain("x");
    expect(keptAt(14.45)).not.toContain("x");
  });

  it("leaves environments with fewer than 5 observations unfiltered", () => {
    const four = [obs("a", 10), obs("b", 10), obs("c", 10), obs("x", 500)];
    const result = filterOutliers(new Map([[4, new Map([["env", four]])]]));
    expect(ids(result.kept.get(4)?.get("env"))).toEqual(["a", "b", "c", "x"]);
    expect(result.dropsBySphere.get(4)).toBe(0);

    const five = [...four.slice(0, 3), obs("d", 10), obs("x", 500)];
    expect(ids(filterOutliers(new Map([[4, new Map([["env", five]])]])).kept.get(4)?.get("env"))).toEqual([
      "a",
      "b",
      "c",
      "d"
    ]);
  });

  it("attributes each dropped observation once to each contributing source key", () => {
    const base = [obs("a", 0, ["p1"]), obs("b", 0, ["p1"]), obs("c", 0, ["p2"]), obs("d", 0, ["p2"])];
    const result = filterOutliers(
      new Map([
        [4, new Map([["env4", [...base, obs("x", 50, ["p3", "p4", "p3"])]]])],
        [3, new Map([
          ["env3a", [...base, obs("x", 50, ["p3", "p4", "p3"])]],
          ["env3b", [...base, obs("y", -50, ["p4"])]]
        ])]
      ])
    );
    expect(result.dropsBySphere.get(4)).toBe(1);
    expect(result.dropsBySphere.get(3)).toBe(2);
    expect(result.dropsByEnvironment.get(3)).toEqual(new Map([["env3a", 1], ["env3b", 1]]));
    expect(result.dropsBySourceKey).toEqual(new Map([["p3", 2], ["p4", 3]]));
    expect(result.dropsBySourceKey.has("p1")).toBe(false);
  });

  it("does not mutate its input", () => {
    const list = [obs("a", 0), obs("b", 0), obs("c", 0), obs("d", 0), obs("x", 50)];
    filterOutliers(new Map([[4, new Map([["env", list]])]]));
    expect(ids(list)).toEqual(["a", "b", "c", "d", "x"]);
  });
});

describe("gnnExcludedStereoIdcodes (§4 step 3, GNN training)", () => {
  interface Mol extends OutlierObservation {
    stereoFreeIdcode: string;
  }
  const mol = (stereoFreeIdcode: string, shift: number): Mol => ({ stereoFreeIdcode, shift, sourceKeys: [`src-${stereoFreeIdcode}`] });
  const tight = (prefix: string): Mol[] => [10, 10.5, 9.5, 10.2, 9.8].map((shift, i) => mol(`${prefix}${i}`, shift));
  const wide = (prefix: string): Mol[] => [20, 40, 25, 35, 30.5].map((shift, i) => mol(`${prefix}${i}`, shift));

  function excluded(input: SphereEnvironments<Mol>, gnn: { stereoIdcode: string; stereoFreeIdcode: string }[]): string[] {
    return gnnExcludedStereoIdcodes(input, filterOutliers(input), gnn);
  }

  it("excludes every stereo idcode of a molecule dropped at its deepest sphere with ≥ 5 observations", () => {
    // Sphere 4 has 6 observations including x, which sits far from tight neighbors and drops.
    const input = new Map([
      [4, new Map([["env4", [...tight("a"), mol("x", 30)]]])],
      [3, new Map([["env3", [...wide("b"), mol("x", 30)]]])]
    ]);
    expect(
      excluded(input, [
        { stereoIdcode: "x-R", stereoFreeIdcode: "x" },
        { stereoIdcode: "x-S", stereoFreeIdcode: "x" },
        { stereoIdcode: "a0", stereoFreeIdcode: "a0" }
      ])
    ).toEqual(["x-R", "x-S"]);
  });

  it("keeps a molecule dropped at sphere 3 but kept at sphere 4", () => {
    // Sphere 4: x is in a wide environment and survives. Sphere 3: x is among tight neighbors and
    // is dropped there, but sphere 4 is deeper and had ≥ 5 observations, so it decides.
    const input = new Map([
      [4, new Map([["env4", [...wide("a"), mol("x", 30)]]])],
      [3, new Map([["env3", [...tight("b"), mol("x", 30)]]])]
    ]);
    const result = filterOutliers(input);
    expect(result.dropsBySphere.get(3)).toBe(1);
    expect(result.dropsBySphere.get(4)).toBe(0);
    expect(gnnExcludedStereoIdcodes(input, result, [{ stereoIdcode: "x-E", stereoFreeIdcode: "x" }])).toEqual([]);
  });

  it("skips spheres with fewer than 5 observations and decides at the next one down", () => {
    // Sphere 4's environment has only 2 observations (unfiltered); sphere 3 drops x.
    const input = new Map([
      [4, new Map([["env4", [mol("x", 30), mol("y", 10)]]])],
      [3, new Map([["env3", [...tight("b"), mol("x", 30)]]])],
      [2, new Map([["env2", [...wide("c"), mol("x", 30)]]])]
    ]);
    expect(excluded(input, [{ stereoIdcode: "x-Z", stereoFreeIdcode: "x" }])).toEqual(["x-Z"]);
  });

  it("keeps a molecule with no sphere of ≥ 5 observations", () => {
    const input = new Map([
      [4, new Map([["env4", [mol("x", 300), mol("y", 10)]]])],
      [3, new Map([["env3", [mol("x", 300), mol("y", 10), mol("z", 10), mol("w", 10)]]])],
      [1, new Map([["env1", [mol("x", 300)]]])]
    ]);
    expect(excluded(input, [{ stereoIdcode: "x", stereoFreeIdcode: "x" }])).toEqual([]);
    // A molecule absent from every environment is kept too.
    expect(excluded(input, [{ stereoIdcode: "q", stereoFreeIdcode: "q" }])).toEqual([]);
  });

  it("orders spheres numerically, deepest first, whatever the map order", () => {
    const input = new Map([
      [1, new Map([["env1", [...tight("b"), mol("x", 30)]]])],
      [2, new Map([["env2", [...wide("a"), mol("x", 30)]]])]
    ]);
    expect(excluded(input, [{ stereoIdcode: "x", stereoFreeIdcode: "x" }])).toEqual([]);
  });

  it("returns byte-sorted stereo idcodes and refuses a molecule in two environments of one sphere", () => {
    const input = new Map([[4, new Map([["env4", [...tight("a"), mol("x", 30), mol("y", -30)]]])]]);
    expect(
      excluded(input, [
        { stereoIdcode: "y", stereoFreeIdcode: "y" },
        { stereoIdcode: "X", stereoFreeIdcode: "x" },
        { stereoIdcode: "x", stereoFreeIdcode: "x" }
      ])
    ).toEqual(["X", "x", "y"]);
    const twice = new Map([[4, new Map([["e1", [mol("x", 1)]], ["e2", [mol("x", 1)]]])]]);
    expect(() => excluded(twice, [])).toThrow();
  });
});
