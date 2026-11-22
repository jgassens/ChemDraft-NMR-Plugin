import { describe, expect, it } from "vitest";

import { collapseMolecules, filterOutliers, type OutlierObservation } from "../providers/ocl/f19";

interface Obs extends OutlierObservation {
  idcode: string;
}

function obs(idcode: string, shift: number, sourceKeys: string[] = [`src-${idcode}`]): Obs {
  return { idcode, shift, sourceKeys };
}

function ids(observations: readonly Obs[] | undefined): string[] {
  return (observations ?? []).map(({ idcode }) => idcode);
}

describe("collapseMolecules (§4 step 2)", () => {
  it("collapses rows to one observation per idcode with median, spread, count and sorted sources", () => {
    const result = collapseMolecules([
      { idcode: "b", shift: -60, sourceKey: "paper-z" },
      { idcode: "a", shift: -120, sourceKey: "paper-y" },
      { idcode: "b", shift: -64, sourceKey: "paper-x" },
      { idcode: "b", shift: -61, sourceKey: "paper-z" },
      { idcode: "a", shift: -121, sourceKey: "paper-x" }
    ]);
    expect(result).toEqual([
      { idcode: "a", shift: -120.5, spread: 1, rowCount: 2, sourceKeys: ["paper-x", "paper-y"] },
      { idcode: "b", shift: -61, spread: 4, rowCount: 3, sourceKeys: ["paper-x", "paper-z"] }
    ]);
  });

  it("uses the even-count median and byte order for keys", () => {
    const [only] = collapseMolecules([
      { idcode: "a", shift: 1, sourceKey: "b" },
      { idcode: "a", shift: 2, sourceKey: "B" },
      { idcode: "a", shift: 3, sourceKey: "a" },
      { idcode: "a", shift: 10, sourceKey: "a" }
    ]);
    expect(only.shift).toBe(2.5);
    expect(only.spread).toBe(9);
    expect(only.rowCount).toBe(4);
    expect(only.sourceKeys).toEqual(["B", "a", "b"]);
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
