import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";

import { describePackageArtifact, extractPackageArtifact } from "./packageArtifact";

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

describePackageArtifact("packaged plugin asset references", (artifact) => {
  it("resolves every relative reference from every .js file to a file inside the package", () => {
    const { directory: extractDir, cleanup } = extractPackageArtifact(artifact);
    try {
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
      cleanup();
    }
  });

  it("emits the OpenChemLib resources JSON exactly once", () => {
    const listing = execFileSync("unzip", ["-Z1", artifact.zipPath], { encoding: "utf8" });
    const entries = listing.trim().split("\n");
    const resourceFiles = entries.filter((entry) => /resources-.*\.json$/.test(entry));
    expect(resourceFiles).toHaveLength(1);
    expect(entries.some((entry) => entry.startsWith("assets/"))).toBe(false);
  });
});
