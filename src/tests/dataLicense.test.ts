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
const phosphorusDatasetPath = "src/providers/ocl/ilm-nmr-p31.database.json";
const phosphorusNoticeFile = "src/providers/ocl/ILM_NMR_P31_LICENSE.md";
const modelPath = "src/providers/gnn/model";
const modelFiles = [
  "src/providers/gnn/model/1H.fp16.onnx",
  "src/providers/gnn/model/13C.fp16.onnx",
  "src/providers/gnn/model/domain.json"
];
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
  for (const file of [noticeFile, phosphorusNoticeFile, "THIRD_PARTY_NOTICES.md"]) {
    expect(unpack(file)).toBe(readFileSync(join(pluginRoot, file), "utf8"));
  }
}

describe("bundled database licenses", () => {
  it("declares every bundled data asset in package metadata separately from MIT code", () => {
    expect(packageJson.license).toBe("MIT");
    expect(packageJson.dataLicenses).toEqual([
      {
        name: "NMRShiftDB2-derived HOSE shift statistics",
        path: datasetPath,
        license: "nmrshiftdb2 Database License (ODbL-derived)",
        noticeFile
      },
      {
        name: "Ilm-NMR-P31-derived ³¹P HOSE shift statistics",
        citation: "Ilm-NMR-P31, Hack et al. (2023), doi:10.1186/s13321-023-00792-y",
        repository: "https://github.com/clacor/Ilm-NMR-P31",
        commit: "ead6f914d2bdfb60e4befea72ea503d32978d358",
        path: phosphorusDatasetPath,
        license: "BSD-3-Clause",
        copyright: "(c) 2026 Robert Geitner",
        noticeFile: phosphorusNoticeFile,
        note: "redistributed with the author's permission (owner, 2026-11-20)"
      },
      {
        name: "NMRShiftDB2-derived GNN shift model weights and training-domain counts",
        path: modelPath,
        files: modelFiles,
        license: "nmrshiftdb2 Database License (ODbL-derived)",
        noticeFile
      }
    ]);
    for (const file of modelFiles) {
      expect(existsSync(join(pluginRoot, file))).toBe(true);
    }
    for (const { path } of packageJson.dataLicenses) {
      expect(existsSync(join(pluginRoot, path))).toBe(true);
    }
    const notice = readFileSync(join(pluginRoot, noticeFile), "utf8");
    expect(notice).toContain("nmrshiftdb2 contributors");
    expect(notice).toContain("Share-alike");
    expect(notice).toContain("nmrshiftdb2datalicense.txt");
    // The GNN weights are NMRShiftDB2-derived data: same terms as the HOSE table, never MIT.
    expect(notice).toContain("GNN shift model weights");
    for (const file of modelFiles) expect(notice).toContain(file);
    expect(packageJson.dataLicenses.filter((entry) => entry.license.includes("MIT"))).toEqual([]);
    const phosphorusNotice = readFileSync(join(pluginRoot, phosphorusNoticeFile), "utf8");
    expect(phosphorusNotice).toContain("BSD 3-Clause License");
    expect(phosphorusNotice).toContain("Copyright (c) 2026, Robert Geitner");
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

describePackageArtifact("packaged database license notices", (artifact) => {
  it("includes the package declaration and its promised attribution files", () => {
    expectPackagedNotices(artifact.zipPath);
  });
});
