import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import packageJson from "../../package.json" with { type: "json" };

// Exercises the zip `npm run package` produces. Skips cleanly when that zip hasn't been built in this
// checkout, rather than building it itself — packaging runs Vite and requires a clean Git tree, both
// too heavy/order-dependent to force from a unit test.
const zipPath = join(process.cwd(), "dist", "plugin-packages", `nmr-predictor-${packageJson.version}.zip`);

/** Every relative reference a built .js file makes to a sibling file: `new URL("x", import.meta.url)`,
 *  static `from "./x"`, and dynamic `import("./x")`. */
function extractReferences(source: string): string[] {
  const references: string[] = [];
  for (const match of source.matchAll(/new URL\(\s*"([^"]+)"\s*,\s*import\.meta\.url\s*\)/g)) {
    references.push(match[1]);
  }
  for (const match of source.matchAll(/(?:from|import)\(?\s*"(\.\/[^"]+)"\)?/g)) {
    references.push(match[1]);
  }
  return references;
}

describe.skipIf(!existsSync(zipPath))("packaged plugin asset references", () => {
  it("resolves every relative reference from every .js file to a file inside the package", () => {
    const extractDir = mkdtempSync(join(tmpdir(), "nmr-predictor-package-"));
    try {
      execFileSync("unzip", ["-q", zipPath, "-d", extractDir]);

      const files = readdirSync(extractDir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath ?? entry.path, entry.name));

      const jsFiles = files.filter((file) => file.endsWith(".js"));
      expect(jsFiles.length).toBeGreaterThan(0);

      const missing: string[] = [];
      for (const file of jsFiles) {
        const source = readFileSync(file, "utf8");
        for (const reference of extractReferences(source)) {
          const resolved = join(dirname(file), reference);
          if (!existsSync(resolved) || !statSync(resolved).isFile()) {
            missing.push(`${file} -> ${reference}`);
          }
        }
      }
      expect(missing).toEqual([]);
    } finally {
      rmSync(extractDir, { recursive: true, force: true });
    }
  });

  it("emits the OpenChemLib resources JSON exactly once", () => {
    const listing = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" });
    const entries = listing.trim().split("\n");
    const resourceFiles = entries.filter((entry) => /resources-.*\.json$/.test(entry));
    expect(resourceFiles).toHaveLength(1);
    expect(entries.some((entry) => entry.startsWith("assets/"))).toBe(false);
  });
});
