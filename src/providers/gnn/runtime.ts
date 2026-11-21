/**
 * Lazy ONNX Runtime Web wrapper for the shipped GNN models.
 *
 * Nothing is fetched, imported or compiled until a ¹H or ¹³C prediction asks for that nucleus's model
 * (never at plugin start, never for ³¹P). On that first request the model bytes are fetched from the
 * plugin package, their SHA-256 is checked against `GNN_MODEL_FILES`, and only then is
 * `onnxruntime-web` imported (its own chunk) and an inference session created on the single-threaded
 * WebAssembly backend. The outcome, success or failure, is cached for the life of the worker.
 *
 * Failure is a state, not an exception: a missing file, a checksum mismatch, or a runtime that fails
 * to load all yield `{ status: "unavailable" }`, and the predictor falls back to the HOSE lookup
 * (ABSTENTION.md section 2). An unverified model is never run.
 *
 * Asset URLs use the `new URL("<literal>", import.meta.url)` form so the packaging build (Vite) emits
 * the two models, the ONNX Runtime WebAssembly binary and its loader module as co-located files of
 * the plugin package and rewrites these URLs to them. No network access is involved: the files are
 * read from the installed package.
 */
import { GNN_MODEL_FILES, type GnnNucleus } from "./modelRelease";
import type { GnnMoleculeFeatures } from "./featurize";
import { gnnInputShapes, type GnnInputTensors } from "./tensors";

/** The pinned runtime. Must equal the exact `onnxruntime-web` version in package.json. */
export const ONNX_RUNTIME_WEB_VERSION = "1.22.0";

export type GnnModelUnavailableReason = "missing" | "checksum-mismatch" | "load-failed";

export interface GnnModelInput {
  /** The schema-1 features the predictor computed for the molecule. */
  features: GnnMoleculeFeatures;
  /** The ONNX input tensors packed from those features. */
  tensors: GnnInputTensors;
}

export interface GnnModel {
  nucleus: GnnNucleus;
  sha256: string;
  /** One de-normalized ppm value per graph node, in node order. */
  run(input: GnnModelInput): Promise<Float32Array>;
}

export type GnnModelState =
  | { status: "ready"; model: GnnModel }
  | { status: "unavailable"; nucleus: GnnNucleus; reason: GnnModelUnavailableReason; message: string };

/** What the predictor needs from a model source. Tests substitute their own. */
export interface GnnModelProvider {
  load(nucleus: GnnNucleus): Promise<GnnModelState>;
}

/** The slice of `onnxruntime-web` this module uses. */
export interface OrtTensorLike {
  readonly dims: readonly number[];
  readonly type: string;
  readonly data: unknown;
}
export interface OrtSessionLike {
  run(feeds: Record<string, OrtTensorLike>): Promise<Record<string, OrtTensorLike>>;
}
export interface OrtModuleLike {
  env: { wasm: { numThreads?: number; proxy?: boolean; wasmPaths?: unknown } };
  Tensor: new (type: string, data: Float32Array | Int32Array | Uint8Array, dims: readonly number[]) => OrtTensorLike;
  InferenceSession: {
    create(model: Uint8Array, options?: { executionProviders?: string[] }): Promise<OrtSessionLike>;
  };
}

export interface GnnModelRuntimeOptions {
  /** Reads a packaged asset. Default: `fetch` of the asset URL. */
  fetchAsset?: (url: URL) => Promise<ArrayBuffer | Uint8Array>;
  /** Imports ONNX Runtime Web. Default: a dynamic import of `onnxruntime-web/wasm`. */
  loadOrt?: () => Promise<OrtModuleLike>;
  /** Asset URLs. Default: the files bundled with the plugin. */
  modelUrl?: (nucleus: GnnNucleus) => URL;
  runtimeUrls?: () => { mjs: URL; wasm: URL };
  /** Expected SHA-256 per model. Default: `GNN_MODEL_FILES`. */
  expectedSha256?: (nucleus: GnnNucleus) => string;
}

/** The bundled model files. Each literal `new URL(...)` is what the packaging build rewrites. */
export function bundledModelUrl(nucleus: GnnNucleus): URL {
  return nucleus === "1H"
    ? new URL("./model/1H.fp16.onnx", import.meta.url)
    : new URL("./model/13C.fp16.onnx", import.meta.url);
}

/** ONNX Runtime Web's single-threaded WebAssembly build: the binary and the loader module that
 *  instantiates it. Version 1.22.0 ships one binary for both modes (`ort-wasm-simd-threaded`); with
 *  `numThreads = 1` it runs on one thread and needs no cross-origin isolation. */
export function bundledRuntimeUrls(): { mjs: URL; wasm: URL } {
  return {
    mjs: new URL("../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs", import.meta.url),
    wasm: new URL("../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm", import.meta.url)
  };
}

async function fetchBundledAsset(url: URL): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url.pathname.split("/").pop() ?? "asset"}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function importOrt(): Promise<OrtModuleLike> {
  return (await import("onnxruntime-web/wasm")) as unknown as OrtModuleLike;
}

/** Lowercase hex SHA-256 via Web Crypto (Node 20+ and every Web Worker in a secure context). */
export async function sha256OfBytes(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto is unavailable, so the model checksum cannot be verified.");
  const digest = await subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class GnnInferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GnnInferenceError";
  }
}

/**
 * Per-nucleus lazy model loader. `load(nucleus)` starts the work on its first call and returns the
 * same promise afterwards.
 */
export class GnnModelRuntime implements GnnModelProvider {
  private readonly fetchAsset: (url: URL) => Promise<ArrayBuffer | Uint8Array>;
  private readonly loadOrt: () => Promise<OrtModuleLike>;
  private readonly modelUrl: (nucleus: GnnNucleus) => URL;
  private readonly runtimeUrls: () => { mjs: URL; wasm: URL };
  private readonly expectedSha256: (nucleus: GnnNucleus) => string;
  private readonly states = new Map<GnnNucleus, Promise<GnnModelState>>();
  private ort: Promise<OrtModuleLike> | undefined;

  constructor(options: GnnModelRuntimeOptions = {}) {
    this.fetchAsset = options.fetchAsset ?? fetchBundledAsset;
    this.loadOrt = options.loadOrt ?? importOrt;
    this.modelUrl = options.modelUrl ?? bundledModelUrl;
    this.runtimeUrls = options.runtimeUrls ?? bundledRuntimeUrls;
    this.expectedSha256 = options.expectedSha256 ?? ((nucleus) => GNN_MODEL_FILES[nucleus].sha256);
  }

  /** Nuclei whose load has started. */
  get requested(): readonly GnnNucleus[] {
    return [...this.states.keys()];
  }

  load(nucleus: GnnNucleus): Promise<GnnModelState> {
    let state = this.states.get(nucleus);
    if (!state) {
      state = this.open(nucleus);
      this.states.set(nucleus, state);
    }
    return state;
  }

  private runtime(): Promise<OrtModuleLike> {
    this.ort ??= this.loadOrt().then((ort) => {
      const urls = this.runtimeUrls();
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      ort.env.wasm.wasmPaths = { mjs: urls.mjs.href, wasm: urls.wasm.href };
      return ort;
    });
    return this.ort;
  }

  private async open(nucleus: GnnNucleus): Promise<GnnModelState> {
    const unavailable = (reason: GnnModelUnavailableReason, message: string): GnnModelState => ({
      status: "unavailable",
      nucleus,
      reason,
      message
    });
    let bytes: Uint8Array;
    try {
      const raw = await this.fetchAsset(this.modelUrl(nucleus));
      bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    } catch (error) {
      return unavailable("missing", `The ${nucleus} model file could not be read: ${describeError(error)}`);
    }
    const expected = this.expectedSha256(nucleus);
    let actual: string;
    try {
      actual = await sha256OfBytes(bytes);
    } catch (error) {
      return unavailable("load-failed", describeError(error));
    }
    if (actual !== expected) {
      return unavailable("checksum-mismatch", `The ${nucleus} model file's SHA-256 ${actual} does not match ${expected}.`);
    }
    let session: OrtSessionLike;
    let ort: OrtModuleLike;
    try {
      ort = await this.runtime();
      session = await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"] });
    } catch (error) {
      return unavailable("load-failed", `The ${nucleus} model could not be loaded: ${describeError(error)}`);
    }
    // One run at a time per session.
    let queue: Promise<unknown> = Promise.resolve();
    const run = async ({ tensors }: GnnModelInput): Promise<Float32Array> => {
      const shapes = gnnInputShapes(tensors);
      const feeds = {
        atoms: new ort.Tensor("float32", tensors.atoms, shapes.atoms),
        neighbor: new ort.Tensor("int32", tensors.neighbor, shapes.neighbor),
        bonds: new ort.Tensor("float32", tensors.bonds, shapes.bonds),
        mask: new ort.Tensor("bool", tensors.mask, shapes.mask)
      };
      const outputs = await session.run(feeds);
      const ppm = outputs.ppm;
      if (!ppm || ppm.type !== "float32" || !(ppm.data instanceof Float32Array)) {
        throw new GnnInferenceError(`The ${nucleus} model returned no float32 ppm output.`);
      }
      if (ppm.dims.length !== 2 || ppm.dims[0] !== 1 || ppm.dims[1] !== tensors.atomCount) {
        throw new GnnInferenceError(`The ${nucleus} model returned ppm of shape [${ppm.dims.join(", ")}].`);
      }
      const values = Float32Array.from(ppm.data);
      if (!values.every(Number.isFinite)) throw new GnnInferenceError(`The ${nucleus} model returned a non-finite shift.`);
      return values;
    };
    const model: GnnModel = {
      nucleus,
      sha256: actual,
      run: (input) => {
        const result = queue.then(() => run(input));
        queue = result.catch(() => undefined);
        return result;
      }
    };
    return { status: "ready", model };
  }
}
