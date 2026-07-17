/**
 * Build the ChemDraft NMR-predictor plugin into its **installable package** — the zip a host downloads
 * and installs (ADR-0029 §5, M35).
 *
 *   npm run package                 # packages this repo (plugin dir = repo root) as nmr-predictor
 *   tsx tools/plugin-package/package.ts -- <plugin-dir> [--out dir] [--entry file] [--name base]
 *
 * What comes out:
 *
 *   <name>-<version>/            (staged, then zipped flat)
 *   ├── manifest.json            id/name/version/apiVersion/permissions/contributions + built entry
 *   │                            filename + provenance — everything a host needs, no monorepo required
 *   ├── entry.js                 the built ES-module worker entry; calls runPluginWorker()
 *   ├── *.js                     whatever chunks the plugin needs (incl. the OCL worker + inlined DB),
 *   │                            CO-LOCATED
 *   └── LICENSE                  verbatim from the plugin
 *   + <name>-<version>.zip.sha256  integrity only — never a trust gate (ADR-0029 §4)
 *
 * Two build settings are load-bearing rather than stylistic:
 *
 *  - **`worker.format: "es"`** — the default `iife` cannot code-split a worker bundle, and this plugin
 *    forces splitting (it spawns a nested OpenChemLib worker). This mirrors the desktop app's build.
 *  - **`base: "./"`** — the decisive one for a *relocatable* package. With a relative base every emitted
 *    reference (e.g. `new URL("nmrWorker-*.js", import.meta.url)`) resolves against the *importing
 *    module's own URL*, so the package works from whatever directory a host stages it into, provided its
 *    files stay co-located and are served from a real (non-blob) URL. See reports/0030.
 *
 * STANDALONE ADAPTATION (ADR-0031): extracted from the ChemDraft monorepo's `tools/plugin-package`.
 * Changes from the monorepo copy, all confined to resolving what used to be workspace-internal:
 *   1. the SDK contracts are imported from the installed, vendored `@chemdraft/plugin-api` package
 *      (was `../../packages/plugin-api/src/index`);
 *   2. Vite is resolved from this repo's own `node_modules` (was `apps/desktop/package.json`);
 *   3. a `--name` override lets the release keep the `nmr-predictor` basename even though the repo
 *      directory is `chemdraft-nmr-plugin`.
 * The fail-closed gates (SDK boundary clean, Git tree clean, LICENSE present) are unchanged.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

// From the installed, vendored SDK package (ADR-0031) rather than monorepo source.
import {
  createPackagedPluginManifestDocument,
  PACKAGED_PLUGIN_MANIFEST_FILE,
  PluginManifestSchema,
  type PluginManifest
} from "@chemdraft/plugin-api";
import { PLUGIN_SDK_PACKAGE } from "../plugin-extract/checkBoundary";
import {
  assertPluginBoundary,
  canonicalPath,
  distributionName,
  findLicense,
  PluginGateError,
  readPluginGitState,
  readPluginPackageJson,
  repositoryRoot,
  sdkVersionFrom
} from "../plugin-extract/gates";

/** Worker entry a plugin ships to be packageable, relative to its root. */
export const DEFAULT_WORKER_ENTRY = join("src", "workerEntry.ts");
/** Filename of the built worker entry inside the package; recorded as the manifest's `entry`. */
export const PACKAGE_ENTRY_FILENAME = "entry.js";
/** Default output directory. */
export const DEFAULT_OUT_DIR = join("dist", "plugin-packages");

export class PluginPackagingError extends PluginGateError {
  constructor(message: string) {
    super(message);
    this.name = "PluginPackagingError";
  }
}

const gateError = (message: string): PluginGateError => new PluginPackagingError(message);

export interface PackagePluginOptions {
  pluginRoot: string;
  outDir?: string;
  repoRoot?: string;
  /** Worker entry override. Defaults to the plugin's own `src/workerEntry.ts`. */
  entry?: string;
  /** Distribution base name override. Defaults to the plugin directory's basename. */
  name?: string;
}

export interface PackagedFile {
  /** Package-relative path, POSIX-separated. */
  path: string;
  bytes: number;
}

export interface PackagePluginResult {
  pluginId: string;
  packageName: string;
  version: string;
  sourceCommit: string;
  sdkVersion: string;
  entryFile: string;
  /** Every file in the package, sorted by descending size. */
  files: readonly PackagedFile[];
  /** Total unpacked size. */
  totalBytes: number;
  stagingDir: string;
  zipPath: string;
  zipBytes: number;
  checksumPath: string;
  sha256: string;
}

/**
 * The slice of Vite this tool drives, typed structurally. The unsafe boundary is contained in
 * {@link loadVite} and nothing untyped escapes it.
 */
interface ViteModule {
  version: string;
  build: (config: ViteInlineConfig) => Promise<unknown>;
}

interface ViteInlineConfig {
  configFile: false;
  root: string;
  base: string;
  logLevel: "silent" | "error" | "warn" | "info";
  worker: { format: "es" };
  build: {
    outDir: string;
    emptyOutDir: boolean;
    target: string;
    minify: boolean;
    modulePreload: boolean;
    reportCompressedSize: boolean;
    chunkSizeWarningLimit: number;
    rollupOptions: {
      input: string;
      output: {
        format: "es";
        entryFileNames: string;
        chunkFileNames: string;
        assetFileNames: string;
      };
    };
  };
}

async function loadVite(repoRoot: string): Promise<ViteModule> {
  // Standalone: Vite is a devDependency of this repo, resolved from its own package.json.
  const requireFromRepo = createRequire(join(repoRoot, "package.json"));
  let vitePath: string;
  try {
    vitePath = requireFromRepo.resolve("vite");
  } catch {
    throw new PluginPackagingError(
      "could not resolve vite; run `npm install` in the repo root before packaging the plugin"
    );
  }
  return (await import(pathToFileURL(vitePath).href)) as ViteModule;
}

/** The worker entry to bundle: an explicit `--entry`, else the plugin's own `src/workerEntry.ts`. */
function resolveWorkerEntry(pluginRoot: string, repoRoot: string, entry: string | undefined): string {
  if (entry) {
    const candidate = resolve(entry);
    const relativeToPlugin = resolve(pluginRoot, entry);
    for (const path of [candidate, relativeToPlugin, resolve(repoRoot, entry)]) {
      if (existsSync(path)) return realpathSync(path);
    }
    throw new PluginPackagingError(`worker entry "${entry}" does not exist`);
  }

  const conventional = join(pluginRoot, DEFAULT_WORKER_ENTRY);
  if (existsSync(conventional)) return realpathSync(conventional);

  throw new PluginPackagingError(
    `plugin has no ${DEFAULT_WORKER_ENTRY}, so there is nothing to run in a worker.\n` +
      "A packageable plugin ships a worker entry that calls runPluginWorker() from " +
      `${PLUGIN_SDK_PACKAGE} with its manifest and command handlers — only the plugin knows how to wire ` +
      "its own runtime. Add one, or pass --entry <file> to bundle a different entry."
  );
}

/**
 * The plugin's manifest, read from its own source rather than hand-copied into the tool: import the
 * plugin's index and take the single export that validates as a {@link PluginManifest}. Anything else is
 * ambiguous and refused rather than guessed at.
 */
async function discoverManifest(pluginRoot: string): Promise<PluginManifest> {
  const indexPath = join(pluginRoot, "src", "index.ts");
  if (!existsSync(indexPath)) {
    throw new PluginPackagingError("plugin has no src/index.ts to read its manifest from");
  }

  let exports: Record<string, unknown>;
  try {
    exports = (await import(/* @vite-ignore */ pathToFileURL(indexPath).href)) as Record<string, unknown>;
  } catch (error) {
    throw new PluginPackagingError(
      `could not import the plugin's src/index.ts to read its manifest: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const found = Object.entries(exports).filter(([, value]) => PluginManifestSchema.safeParse(value).success);
  if (found.length === 0) {
    throw new PluginPackagingError("plugin's src/index.ts exports no valid PluginManifest");
  }
  if (found.length > 1) {
    throw new PluginPackagingError(
      `plugin's src/index.ts exports ${found.length} valid PluginManifests (${found
        .map(([name]) => name)
        .join(", ")}); expected exactly one`
    );
  }
  return PluginManifestSchema.parse(found[0][1]);
}

/** Whether `inner` is `outer` or sits underneath it. */
function contains(outer: string, inner: string): boolean {
  const rel = relative(outer, inner);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * Keep staging and the plugin strictly apart, in both directions. Staging is emptied before the build,
 * so a staging directory that *contained* the plugin would delete the source being packaged; and a
 * staging directory *inside* the plugin would spray build output into the plugin's own tree — which the
 * clean-tree gate would then (rightly) refuse on the next run.
 *
 * Standalone: the plugin dir IS the repo root, and the default output (`dist/plugin-packages`) sits
 * inside it. That is fine and expected — `dist/` is git-ignored, so it never dirties the tree; the
 * checks below only forbid staging that would delete the source or land the *archive itself* in a
 * tracked location.
 */
function assertSafePackagePaths(pluginRoot: string, staging: string, zipPath: string): void {
  const resolvedPlugin = resolve(pluginRoot);
  const resolvedStaging = resolve(staging);
  if (contains(resolvedStaging, resolvedPlugin)) {
    throw new PluginPackagingError("output staging directory must not be the plugin directory or one of its parents");
  }
}

/** Every file under `dir`, as package-relative POSIX paths with sizes, largest first. */
function collectFiles(dir: string, prefix = ""): PackagedFile[] {
  const files: PackagedFile[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...collectFiles(full, `${prefix}${entry}/`));
    } else {
      files.push({ path: `${prefix}${entry}`, bytes: stat.size });
    }
  }
  return files.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
}

export async function packagePlugin(options: PackagePluginOptions): Promise<PackagePluginResult> {
  const repoRoot = resolve(options.repoRoot ?? repositoryRoot);
  const pluginRoot = realpathSync(resolve(options.pluginRoot));
  const outDir = canonicalPath(options.outDir ?? join(repoRoot, DEFAULT_OUT_DIR));

  // --- Fail-closed gates, identical to plugin:extract's (ADR-0028 §4) -----------------------------
  assertPluginBoundary(pluginRoot, gateError);
  const licenseFile = findLicense(pluginRoot, gateError);
  const { sourceCommit } = readPluginGitState(pluginRoot, gateError);
  const pkg = readPluginPackageJson(pluginRoot, gateError);
  const name = options.name ?? distributionName(pluginRoot, gateError);
  const sdkVersion = sdkVersionFrom(repoRoot, gateError);

  const workerEntry = resolveWorkerEntry(pluginRoot, repoRoot, options.entry);
  const manifest = await discoverManifest(pluginRoot);

  const staging = join(outDir, `${name}-${pkg.version}`);
  const zipPath = join(outDir, `${name}-${pkg.version}.zip`);
  const checksumPath = `${zipPath}.sha256`;
  assertSafePackagePaths(pluginRoot, staging, zipPath);

  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  const vite = await loadVite(repoRoot);
  await vite.build({
    configFile: false,
    root: repoRoot,
    // Relative base: every emitted reference resolves against the importing module's own URL, so the
    // package is relocatable. See this file's header.
    base: "./",
    logLevel: "silent",
    // ES-module workers: the default iife cannot code-split a worker bundle (M34).
    worker: { format: "es" },
    build: {
      outDir: staging,
      emptyOutDir: true,
      target: "esnext",
      minify: true,
      modulePreload: false,
      reportCompressedSize: false,
      chunkSizeWarningLimit: Number.MAX_SAFE_INTEGER,
      rollupOptions: {
        input: workerEntry,
        output: {
          format: "es",
          entryFileNames: PACKAGE_ENTRY_FILENAME,
          chunkFileNames: "[name]-[hash].js",
          assetFileNames: "[name]-[hash][extname]"
        }
      }
    }
  });

  if (!existsSync(join(staging, PACKAGE_ENTRY_FILENAME))) {
    throw new PluginPackagingError(`the build produced no ${PACKAGE_ENTRY_FILENAME}; the worker entry may be empty`);
  }

  // manifest.json: everything a host needs to identify, permission, and load the plugin — with `entry`
  // repointed at the file we just built, and provenance mirroring EXTRACTED.md.
  const manifestDocument = createPackagedPluginManifestDocument(
    { ...manifest, entry: PACKAGE_ENTRY_FILENAME },
    {
      sdk: PLUGIN_SDK_PACKAGE,
      sdkVersion,
      sourceCommit,
      sourceTree: "clean",
      licenseFile,
      packagedAt: new Date().toISOString()
    }
  );
  writeFileSync(join(staging, PACKAGED_PLUGIN_MANIFEST_FILE), `${JSON.stringify(manifestDocument, null, 2)}\n`);
  cpSync(join(pluginRoot, licenseFile), join(staging, licenseFile));

  mkdirSync(outDir, { recursive: true });
  rmSync(zipPath, { force: true });
  rmSync(checksumPath, { force: true });
  // Flat archive (no wrapping directory): a host unpacks it straight into the plugin's staged directory,
  // where the co-location that makes relative asset URLs resolve is exactly what must be preserved.
  execFileSync("zip", ["-X", "-r", "-q", zipPath, ...readdirSync(staging).sort()], { cwd: staging });

  const zipBytes = statSync(zipPath).size;
  const sha256 = createHash("sha256").update(readFileSync(zipPath)).digest("hex");
  writeFileSync(checksumPath, `${sha256}  ${name}-${pkg.version}.zip\n`);

  const files = collectFiles(staging);
  return {
    pluginId: manifest.id,
    packageName: pkg.name,
    version: pkg.version,
    sourceCommit,
    sdkVersion,
    entryFile: PACKAGE_ENTRY_FILENAME,
    files,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    stagingDir: staging,
    zipPath,
    zipBytes,
    checksumPath,
    sha256
  };
}

export function parseCliArgs(args: string[]): PackagePluginOptions {
  const remaining = args[0] === "--" ? args.slice(1) : [...args];
  const takeFlag = (flag: string): string | undefined => {
    const index = remaining.indexOf(flag);
    if (index < 0) return undefined;
    const value = remaining[index + 1];
    if (!value || value.startsWith("--")) {
      throw new PluginPackagingError(`${flag} requires a value`);
    }
    remaining.splice(index, 2);
    return value;
  };

  const outDir = takeFlag("--out");
  const entry = takeFlag("--entry");
  const name = takeFlag("--name");
  if (remaining.length !== 1) {
    throw new PluginPackagingError(
      "usage: tsx tools/plugin-package/package.ts -- <plugin-dir> [--out dir] [--entry file] [--name base]"
    );
  }
  return { pluginRoot: remaining[0], outDir, entry, name };
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
}

async function runCli(): Promise<void> {
  try {
    const result = await packagePlugin(parseCliArgs(process.argv.slice(2)));
    console.log(`packaged ${result.packageName}@${result.version} (${result.pluginId})`);
    console.log(`  boundary : clean (only ${PLUGIN_SDK_PACKAGE})`);
    console.log(`  source   : ${result.sourceCommit} (clean)`);
    console.log(`  sdk      : ${result.sdkVersion}`);
    console.log(`  entry    : ${result.entryFile}`);
    console.log(`  layout   : ${result.files.length} files, ${formatBytes(result.totalBytes)} unpacked`);
    for (const file of result.files) {
      console.log(`    ${formatBytes(file.bytes).padStart(9)}  ${file.path}`);
    }
    console.log(`  zip      : ${result.zipPath} (${formatBytes(result.zipBytes)})`);
    console.log(`  sha256   : ${result.sha256}`);
    console.log(`  sidecar  : ${result.checksumPath}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`package-plugin: ${message}`);
    process.exitCode = 1;
  }
}

const invokedModule = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedModule === import.meta.url) await runCli();
