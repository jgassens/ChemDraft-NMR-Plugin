/**
 * Canonical JSON-lines serialization of GNN features, shared by the training extract
 * (`scripts/gnn-feature-parity.ts`) and the plugin worker so both can be compared byte for byte.
 *
 * The bytes are fixed by construction rather than by `JSON.stringify` of objects:
 * - keys are written in the fixed order shown in `canonicalFeatureLine`;
 * - every number must be finite and exact in single precision, and prints as ECMAScript
 *   `Number.prototype.toString` (the shortest decimal that round-trips, locale-independent), with
 *   negative zero printed as `0`;
 * - strings go through `JSON.stringify`, whose escaping the language specification fixes;
 * - lines end in `\n` with no other whitespace; text is hashed as UTF-8.
 *
 * Pure and worker-safe: SHA-256 uses Web Crypto (`globalThis.crypto.subtle`), present in Node 20+
 * and in every Web Worker, so no Node-only module is imported.
 */
import type { ChemicalStructureInput } from "../../domain/contracts";
import { isNmrError } from "../../domain/errors";
import { extractMolfile, splitRecords } from "../ocl/nmredata";
import {
  featurizeStructure,
  GNN_ATOM_FEATURE_NAMES,
  GNN_BOND_FEATURE_NAMES,
  GNN_FEATURE_SCHEMA_VERSION,
  GnnFeaturizationError,
  type GnnMoleculeFeatures
} from "./featurize";

export const GNN_DUMP_FORMAT = "chemdraft-gnn-features";

/** The fixed number rule described in the module comment. Throws instead of rounding. */
export function formatFeatureNumber(value: number): string {
  if (!Number.isFinite(value) || Math.fround(value) !== value) {
    throw new Error(`Cannot serialize ${value}: not a finite single-precision value.`);
  }
  return Object.is(value, -0) ? "0" : String(value);
}

function numberArray(values: readonly number[]): string {
  return `[${values.map(formatFeatureNumber).join(",")}]`;
}

/** First line of every dump: identifies the schema so a feature-order change alters the hash. */
export function canonicalDumpHeader(): string {
  return (
    `{"format":${JSON.stringify(GNN_DUMP_FORMAT)}` +
    `,"schemaVersion":${JSON.stringify(GNN_FEATURE_SCHEMA_VERSION)}` +
    `,"atomFeatures":[${GNN_ATOM_FEATURE_NAMES.map((name) => JSON.stringify(name)).join(",")}]` +
    `,"bondFeatures":[${GNN_BOND_FEATURE_NAMES.map((name) => JSON.stringify(name)).join(",")}]}\n`
  );
}

export interface CanonicalRecordIdentity {
  /** 0-based record position in the SD file. */
  index: number;
  /** SHA-256 (hex) of the record's molfile block, or null when the record has none. */
  molfileSha256: string | null;
}

/** One featurized record: `index, molfileSha256, schemaVersion, heavyAtomIndexMap, atoms, bonds`. */
export function canonicalFeatureLine(identity: CanonicalRecordIdentity, features: GnnMoleculeFeatures): string {
  const bonds = features.bonds.map((bond) =>
    `{"from":${formatFeatureNumber(bond.from)},"to":${formatFeatureNumber(bond.to)},"features":${numberArray(bond.features)}}`
  );
  return (
    `{"index":${formatFeatureNumber(identity.index)}` +
    `,"molfileSha256":${JSON.stringify(identity.molfileSha256)}` +
    `,"schemaVersion":${JSON.stringify(features.schemaVersion)}` +
    `,"heavyAtomIndexMap":${numberArray(features.heavyAtomIndexMap)}` +
    `,"atoms":[${features.atoms.map(numberArray).join(",")}]` +
    `,"bonds":[${bonds.join(",")}]}\n`
  );
}

/** A record that could not be featurized: `index, molfileSha256, error` (a stable code only). */
export function canonicalErrorLine(identity: CanonicalRecordIdentity, code: string): string {
  return (
    `{"index":${formatFeatureNumber(identity.index)}` +
    `,"molfileSha256":${JSON.stringify(identity.molfileSha256)}` +
    `,"error":${JSON.stringify(code)}}\n`
  );
}

/** Stable error code for the dump. Messages are never written: only codes are part of the contract. */
export function featurizationErrorCode(error: unknown): string {
  if (error instanceof GnnFeaturizationError || isNmrError(error)) return error.code;
  return "GNN_FEATURIZATION_FAILED";
}

/** The structure input a molfile block is featurized as, by the version tag on its counts line
 * (line 4; `extractMolfile` rebuilds the header from that line). */
export function molfileStructureInput(molfile: string): ChemicalStructureInput {
  const countsLine = molfile.split("\n")[3] ?? "";
  return { format: countsLine.includes("V3000") ? "molfile-v3000" : "molfile-v2000", value: molfile };
}

export interface CanonicalFeatureDump {
  text: string;
  sha256: string;
  records: number;
  featurized: number;
  errors: number;
}

/**
 * Featurize every record of an SD file and return the canonical dump and its SHA-256. Line endings
 * are normalized to `\n` first; records are split on `$$$$` and their molfile block is extracted
 * exactly as the HOSE database compiler does (`splitRecords`, `extractMolfile`).
 */
export async function buildCanonicalFeatureDump(sdContent: string): Promise<CanonicalFeatureDump> {
  const records = splitRecords(sdContent.replace(/\r\n?/g, "\n"));
  const lines = [canonicalDumpHeader()];
  let featurized = 0;
  for (const [index, record] of records.entries()) {
    const molfile = extractMolfile(record);
    const identity = { index, molfileSha256: molfile === undefined ? null : await sha256Hex(molfile) };
    if (molfile === undefined) {
      lines.push(canonicalErrorLine(identity, "GNN_NO_MOLFILE"));
      continue;
    }
    try {
      lines.push(canonicalFeatureLine(identity, featurizeStructure(molfileStructureInput(molfile))));
      featurized += 1;
    } catch (error) {
      lines.push(canonicalErrorLine(identity, featurizationErrorCode(error)));
    }
  }
  const text = lines.join("");
  return { text, sha256: await sha256Hex(text), records: records.length, featurized, errors: records.length - featurized };
}

/** Lowercase hex SHA-256 of the UTF-8 encoding of `text`, via Web Crypto. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
