import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

interface PackagePaths {
  stagingDir: string;
  zipPath: string;
  checksumPath: string;
}

/** The standalone bundler copies only LICENSE. Add package metadata and every declared data notice
 * before publishing its zip/checksum, without extending the SDK's strict runtime manifest. */
export function addPackageNotices(pluginRoot: string, paths: PackagePaths): void {
  // A failed notice copy must not leave an apparently distributable archive or integrity sidecar.
  rmSync(paths.zipPath, { force: true });
  rmSync(paths.checksumPath, { force: true });

  const pkg = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8")) as {
    dataLicenses: { name: string; license: string; noticeFile: string }[];
  };
  if (!pkg.dataLicenses?.length) throw new Error("package.json must declare bundled dataLicenses");

  const notices = pkg.dataLicenses.map((entry) => {
    if (!entry.name?.trim() || !entry.license?.trim() || !entry.noticeFile?.trim()) {
      throw new Error("Each bundled dataset needs a name, license, and noticeFile");
    }
    return entry.noticeFile;
  });
  for (const file of new Set(["package.json", "THIRD_PARTY_NOTICES.md", ...notices])) {
    const source = resolve(pluginRoot, file);
    const rel = relative(resolve(pluginRoot), source);
    if (isAbsolute(file) || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) {
      throw new Error(`Notice path must stay inside the plugin: ${file}`);
    }
    const destination = join(paths.stagingDir, file);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }

  execFileSync("zip", ["-X", "-r", "-q", paths.zipPath, ...readdirSync(paths.stagingDir).sort()], {
    cwd: paths.stagingDir
  });
  const sha256 = createHash("sha256").update(readFileSync(paths.zipPath)).digest("hex");
  writeFileSync(paths.checksumPath, `${sha256}  ${basename(paths.zipPath)}\n`);
}
