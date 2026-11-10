import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import packageJson from "../../package.json" with { type: "json" };
import { addPackageNotices } from "../../scripts/package-notices";
import { describePackageArtifact } from "./packageArtifact";

const pluginRoot = fileURLToPath(new URL("../../", import.meta.url));
const datasetPath = "src/providers/ocl/nmrshiftdb2.database.json";
const noticeFile = "src/providers/ocl/NMRSHIFTDB2_LICENSE.md";
const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function temporaryPackage() {
  const root = mkdtempSync(join(tmpdir(), "nmr-data-license-"));
  roots.push(root);
  const stagingDir = join(root, "staging");
  mkdirSync(stagingDir);
  writeFileSync(join(stagingDir, "entry.js"), "export {};\n");
  return { root, stagingDir, zipPath: join(root, "plugin.zip"), checksumPath: join(root, "plugin.zip.sha256") };
}

function expectPackagedNotices(zipPath: string): void {
  const unpack = (file: string) => execFileSync("unzip", ["-p", zipPath, file], { encoding: "utf8" });
  expect(JSON.parse(unpack("package.json")).dataLicenses).toEqual(packageJson.dataLicenses);
  for (const file of [noticeFile, "THIRD_PARTY_NOTICES.md"]) {
    expect(unpack(file)).toBe(readFileSync(join(pluginRoot, file), "utf8"));
  }
}

describe("bundled database licence", () => {
  it("declares the NMRShiftDB2 dataset in package metadata separately from MIT code", () => {
    expect(packageJson.license).toBe("MIT");
    expect(packageJson.dataLicenses).toEqual([
      {
        name: "NMRShiftDB2-derived HOSE shift statistics",
        path: datasetPath,
        license: "nmrshiftdb2 Database License (ODbL-derived)",
        noticeFile
      }
    ]);
    expect(existsSync(join(pluginRoot, datasetPath))).toBe(true);
    const notice = readFileSync(join(pluginRoot, noticeFile), "utf8");
    expect(notice).toContain("nmrshiftdb2 contributors");
    expect(notice).toContain("Share-alike");
    expect(notice).toContain("nmrshiftdb2datalicense.txt");
  });

  it("ships declared notices and package metadata in the zip with an updated checksum", () => {
    const paths = temporaryPackage();
    writeFileSync(paths.zipPath, "stale archive");
    writeFileSync(paths.checksumPath, "stale checksum");
    addPackageNotices(pluginRoot, paths);
    expectPackagedNotices(paths.zipPath);
    expect(execFileSync("unzip", ["-p", paths.zipPath, "entry.js"], { encoding: "utf8" })).toBe("export {};\n");
    const sha256 = createHash("sha256").update(readFileSync(paths.zipPath)).digest("hex");
    expect(readFileSync(paths.checksumPath, "utf8")).toBe(`${sha256}  plugin.zip\n`);
  });

  it("refuses to leave a distributable zip when a declared notice is missing", () => {
    const paths = temporaryPackage();
    writeFileSync(join(paths.root, "package.json"), JSON.stringify({
      dataLicenses: [{ name: "corpus", license: "ODbL-derived", noticeFile: "missing.md" }]
    }));
    writeFileSync(join(paths.root, "THIRD_PARTY_NOTICES.md"), "Attribution");
    writeFileSync(paths.zipPath, "stale archive");
    writeFileSync(paths.checksumPath, "stale checksum");
    expect(() => addPackageNotices(paths.root, paths)).toThrow(/missing.md/);
    expect(existsSync(paths.zipPath)).toBe(false);
    expect(existsSync(paths.checksumPath)).toBe(false);
  });
});

describePackageArtifact("packaged database licence notices", (artifact) => {
  it("includes the package declaration and its promised attribution files", () => {
    expectPackagedNotices(artifact.zipPath);
  });
});
