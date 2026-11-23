import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import packageJson from "../../package.json" with { type: "json" };
import { ILM_P31_PROVENANCE } from "../../scripts/ilm-nmr-p31";
import { addPackageNotices } from "../../scripts/package-notices";
import type { NmrNucleus } from "../domain/contracts";
import bundledPhosphorusDatabase from "../providers/ocl/ilm-nmr-p31.database.json";
import { OclHosePredictor } from "../providers/ocl/OclHosePredictor";
import { composePredictionReport } from "../report/composePredictionReport";
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
    expect(packageJson.dataLicenses.map(({ attribution: _attribution, url: _url, ...rest }) => rest)).toEqual([
      {
        name: "NMRShiftDB2-derived HOSE shift statistics",
        path: datasetPath,
        license: "nmrshiftdb2 Database License (ODbL-derived)",
        noticeFile
      },
      {
        name: "Ilm-NMR-P31-derived ³¹P HOSE shift statistics",
        citation: "Ilm-NMR-P31 v3.0 (Zenodo, doi:10.5281/zenodo.20762603, CC BY 4.0); Hack et al. (2023), doi:10.1186/s13321-023-00792-y",
        repository: "https://github.com/clacor/Ilm-NMR-P31",
        commit: "ead6f914d2bdfb60e4befea72ea503d32978d358",
        path: phosphorusDatasetPath,
        license: "CC-BY-4.0 (Ilm-NMR-P31 v3.0, doi:10.5281/zenodo.20762603); the GitHub copy's own license is BSD-3-Clause",
        copyright: "(c) 2026 Robert Geitner (BSD-3-Clause credit for the GitHub copy)",
        upstream: [
          {
            name: "NMRexp",
            authors: "Wang, Jun-Jie; Zhu, Rong",
            citation: "Wang, J.-J., Jin, Y., Zhi, C.-Y. et al., Scientific Data 12, 1954 (2025), doi:10.1038/s41597-025-06245-5",
            doi: "10.5281/zenodo.17296666",
            license: "CC-BY-4.0",
            note: "the source of about 27,000 of the 43,317 entries in Ilm-NMR-P31 v3.0"
          }
        ],
        noticeFile: phosphorusNoticeFile,
        note: "Built from GitHub clacor/Ilm-NMR-P31 @ ead6f914, identical in content to Ilm-NMR-P31 v3.0 on Zenodo (record 20762603, doi:10.5281/zenodo.20762603, series record 8260782, published 2026-06-19, CC BY 4.0). Values were filtered and transformed into aggregated HOSE shift statistics. Redistributed with the author's permission (owner, 2026-11-20)."
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
    expect(phosphorusNotice).toContain("https://creativecommons.org/licenses/by/4.0/");
    expect(phosphorusNotice).toContain("10.5281/zenodo.20762603");
    expect(phosphorusNotice).toContain("10.5281/zenodo.17296666");
    expect(phosphorusNotice).toContain("Changes were made");
    const phosphorusEntry = packageJson.dataLicenses.find((entry) => entry.path === phosphorusDatasetPath)!;
    expect(phosphorusEntry.license).toContain("CC-BY-4.0");
    expect(phosphorusEntry.license).not.toBe("BSD-3-Clause");
  });

  it("gives every data license entry a credit line and an https link", () => {
    expect(packageJson.dataLicenses.length).toBeGreaterThan(0);
    for (const entry of packageJson.dataLicenses as { name: string; attribution?: unknown; url?: unknown }[]) {
      expect(typeof entry.attribution, entry.name).toBe("string");
      expect((entry.attribution as string).trim().length, entry.name).toBeGreaterThan(0);
      expect(typeof entry.url, entry.name).toBe("string");
      expect(new URL(entry.url as string).protocol, entry.name).toBe("https:");
    }
    const phosphorus = packageJson.dataLicenses.find((entry) => entry.path === phosphorusDatasetPath)!;
    expect(phosphorus.attribution).toContain("Geitner");
    expect(phosphorus.attribution).toContain("10.5281/zenodo.20762603");
    expect(phosphorus.attribution).toContain("10.5281/zenodo.17296666");
    expect(phosphorus.attribution).toContain("CC BY 4.0");
  });

  it("shows the ³¹P table's package.json license and credit line in the prediction report", async () => {
    const declared = packageJson.dataLicenses.find((entry) => entry.path === phosphorusDatasetPath)!;
    // The generator and the bundled table's header carry the same strings as package.json.
    for (const provenance of [ILM_P31_PROVENANCE, bundledPhosphorusDatabase.provenance]) {
      expect(provenance.license).toBe(declared.license);
      expect(provenance.attribution).toBe(declared.attribution);
      expect(provenance.licenseUrl).toBe("https://creativecommons.org/licenses/by/4.0/");
    }
    const predictor = new OclHosePredictor();
    const smiles = "CCP(CC)CC";
    // ³¹P alone (the table is the primary database) and alongside ¹H (a separate ³¹P section).
    for (const nuclei of [["31P"], ["1H", "31P"]] as NmrNucleus[][]) {
      const result = await predictor.predict({
        structure: { format: "smiles", value: smiles },
        nuclei,
        options: { statistic: "median", hoseLevels: [4, 3, 2, 1], ignoreLabileHydrogens: true }
      });
      const report = composePredictionReport({
        objectId: "m1", structure: smiles, structureFormat: "smiles", sourceFingerprint: "fp"
      }, result);
      const index = report.sections.findIndex((section) => section.kind === "keyValue"
        && section.rows.some((row) => row.label === "Measured accuracy (³¹P)"));
      expect(index, nuclei.join(",")).toBeGreaterThanOrEqual(0);
      const database = report.sections[index] as { rows: { label: string; value: string }[] };
      expect(database.rows.find((row) => row.label === "License")?.value).toBe(declared.license);
      expect(report.sections[index + 1]).toMatchObject({ kind: "text", body: declared.attribution });
      expect(JSON.stringify(report.sections)).not.toContain('"value":"BSD-3-Clause"');
    }
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
