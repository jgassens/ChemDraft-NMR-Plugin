import { describe, expect, it } from "vitest";

import { NMR_PLUGIN_CAPABILITIES } from "../index";

describe("NMR plugin capabilities", () => {
  it("advertises the CLI compatibility contract", () => {
    expect(NMR_PLUGIN_CAPABILITIES).toEqual([
      "constitutional-equivalence-grouping",
      "diastereotopic-disclosure",
      "truthful-spectrum-caption"
    ]);
  });
});
