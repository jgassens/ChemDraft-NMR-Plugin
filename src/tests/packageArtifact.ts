import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";

import packageJson from "../../package.json" with { type: "json" };

export interface PackageArtifact {
  zipPath: string;
  sourceCommit: string;
}

interface MissingPackageArtifact {
  reason: string;
}

/**
 * The package tests intentionally exercise only an archive whose provenance describes this exact,
 * clean checkout. This keeps a prior package from either hiding a source change or failing tests for
 * a different revision.
 */
function locatePackageArtifact(): PackageArtifact | MissingPackageArtifact {
  const zipPath = join(process.cwd(), "dist", "plugin-packages", `nmr-predictor-${packageJson.version}.zip`);
  if (!existsSync(zipPath)) {
    return { reason: `package is missing at ${zipPath}; run npm run package` };
  }

  let sourceCommit: string;
  try {
    const manifest = JSON.parse(execFileSync("unzip", ["-p", zipPath, "manifest.json"], { encoding: "utf8" })) as {
      chemdraftPackage?: { sourceCommit?: unknown };
    };
    if (typeof manifest.chemdraftPackage?.sourceCommit !== "string" || manifest.chemdraftPackage.sourceCommit.length === 0) {
      return { reason: `package manifest in ${zipPath} has no chemdraftPackage.sourceCommit; run npm run package` };
    }
    sourceCommit = manifest.chemdraftPackage.sourceCommit;
  } catch (error) {
    return {
      reason: `could not read manifest.json from ${zipPath}: ${error instanceof Error ? error.message : String(error)}; run npm run package`
    };
  }

  let head: string;
  let status: string;
  try {
    head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), encoding: "utf8" }).trim();
    status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: process.cwd(),
      encoding: "utf8"
    }).trim();
  } catch (error) {
    return {
      reason: `could not verify the current Git checkout: ${error instanceof Error ? error.message : String(error)}; run npm run package`
    };
  }

  if (sourceCommit !== head) {
    return { reason: `package built from ${sourceCommit}, HEAD is ${head}; run npm run package` };
  }
  if (status) {
    return { reason: `package built from ${sourceCommit}, but the working tree is dirty; run npm run package` };
  }

  return { zipPath, sourceCommit };
}

function isPackageArtifact(artifact: PackageArtifact | MissingPackageArtifact): artifact is PackageArtifact {
  return "zipPath" in artifact;
}

/**
 * Defines a package test suite. Local developer runs skip an absent or stale archive with a useful
 * suite name; release verification sets CHEMDRAFT_REQUIRE_PACKAGE_TESTS=1 to make that condition fail.
 */
export function describePackageArtifact(name: string, defineTests: (artifact: PackageArtifact) => void): void {
  const artifact = locatePackageArtifact();
  if (isPackageArtifact(artifact)) {
    describe(name, () => defineTests(artifact));
    return;
  }

  if (process.env.CHEMDRAFT_REQUIRE_PACKAGE_TESTS === "1") {
    describe(name, () => {
      it("requires a current installable package", () => {
        throw new Error(artifact.reason);
      });
    });
    return;
  }

  describe.skip(`${name} (${artifact.reason})`, () => undefined);
}

/** Extracts a validated package archive for a test and returns a cleanup function. */
export function extractPackageArtifact(artifact: PackageArtifact): { directory: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "nmr-predictor-package-"));
  try {
    execFileSync("unzip", ["-q", artifact.zipPath, "-d", directory]);
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return { directory, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
