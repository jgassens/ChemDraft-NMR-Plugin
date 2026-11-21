/**
 * Write the canonical GNN feature dump of an SD file and its SHA-256.
 *
 *   node --import tsx scripts/gnn-feature-parity.ts <input.sd> <output.jsonl> [--expect-sha256 <hex>]
 *
 * Output: `<output.jsonl>`, one header line then one line per SD record (see docs/gnn-features.md),
 * and `<output.jsonl>.sha256` in `shasum -a 256` format. A JSON summary goes to stdout. With
 * `--expect-sha256`, the script exits 2 when the dump's hash differs, so a training extract can be
 * checked against the hash the plugin worker produced for the same file (or the reverse).
 *
 * The dump is produced by `buildCanonicalFeatureDump` (src/providers/gnn/canonicalDump.ts), the same
 * pure function the worker runs; this script only reads and writes files.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

import { buildCanonicalFeatureDump } from "../src/providers/gnn/canonicalDump";

const args = process.argv.slice(2);
const expectIndex = args.indexOf("--expect-sha256");
let expected: string | undefined;
if (expectIndex >= 0) {
  expected = args[expectIndex + 1]?.toLowerCase();
  args.splice(expectIndex, 2);
}
const [input, output] = args;
if (!input || !output || args.length !== 2 || (expectIndex >= 0 && !/^[0-9a-f]{64}$/.test(expected ?? ""))) {
  console.error("usage: gnn-feature-parity <input.sd> <output.jsonl> [--expect-sha256 <64 hex digits>]");
  process.exit(1);
}

const dump = await buildCanonicalFeatureDump(readFileSync(input, "utf8"));
writeFileSync(output, dump.text, "utf8");
writeFileSync(`${output}.sha256`, `${dump.sha256}  ${basename(output)}\n`, "utf8");
console.log(JSON.stringify({
  sha256: dump.sha256,
  bytes: Buffer.byteLength(dump.text, "utf8"),
  records: dump.records,
  featurized: dump.featurized,
  errors: dump.errors
}));
if (expected !== undefined && expected !== dump.sha256) {
  console.error(`SHA-256 mismatch: expected ${expected}, got ${dump.sha256}`);
  process.exit(2);
}
