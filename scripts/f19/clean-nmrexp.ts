/**
 * Clean the extracted NMRexp ¹⁹F rows (docs/f19-benchmark.md §2 steps 2–7).
 *
 *   node --import tsx scripts/f19/clean-nmrexp.ts <extracted.jsonl> <cleaned.jsonl> <report.json>
 *
 * Input: the JSONL written by scripts/f19/extract_nmrexp_19f.py. Output: one cleaned record per
 * kept row (JSONL) and a report of counts only. Nothing here prints structures, file names or
 * shifts; the console gets counts only. No split is computed here.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import {
  cleanRow,
  DROP_REASONS,
  FLUORINE_TYPES,
  type CleanedRecord,
  type DropReason,
  type ExtractedRow,
  type FluorineType
} from "../../src/providers/ocl/f19";

const [input, cleanedOutput, reportOutput] = process.argv.slice(2);
if (!input || !cleanedOutput || !reportOutput) {
  console.error("usage: clean-nmrexp <extracted.jsonl> <cleaned.jsonl> <report.json>");
  process.exit(1);
}

const bytes = readFileSync(input);
const inputSha256 = createHash("sha256").update(bytes).digest("hex");

const dropsByReason = Object.fromEntries(DROP_REASONS.map((reason) => [reason, 0])) as Record<DropReason, number>;
const fluorineTypeCounts = Object.fromEntries(FLUORINE_TYPES.map((type) => [type, 0])) as Record<FluorineType, number>;
const sourceKeys = new Set<string>();
const idcodes = new Set<string>();
const cleaned: string[] = [];
let inputRows = 0;
let cdcl3Rows = 0;

const lines = bytes.toString("utf8").split("\n");
for (let index = 0; index < lines.length; index += 1) {
  const line = lines[index];
  if (line.trim() === "") continue;
  let row: ExtractedRow;
  try {
    row = JSON.parse(line) as ExtractedRow;
  } catch {
    // The line number only; never the line's content.
    console.error(`input line ${index + 1} is not JSON`);
    process.exit(1);
  }
  inputRows += 1;
  const result = cleanRow(row);
  if ("drop" in result) {
    dropsByReason[result.drop] += 1;
    continue;
  }
  const record: CleanedRecord = result;
  cleaned.push(JSON.stringify(record));
  sourceKeys.add(record.sourceKey);
  idcodes.add(record.idcode);
  fluorineTypeCounts[record.fluorineType] += 1;
  if (typeof record.solvent === "string" && record.solvent.toLowerCase().includes("cdcl3")) cdcl3Rows += 1;
}

writeFileSync(cleanedOutput, cleaned.length > 0 ? `${cleaned.join("\n")}\n` : "");

const report = {
  inputSha256,
  inputBytes: bytes.byteLength,
  inputRows,
  keptRows: cleaned.length,
  droppedRows: inputRows - cleaned.length,
  dropsByReason,
  distinctSourceKeys: sourceKeys.size,
  distinctIdcodes: idcodes.size,
  fluorineTypeCounts,
  cdcl3Rows,
  cdcl3Fraction: cleaned.length > 0 ? cdcl3Rows / cleaned.length : null
};
writeFileSync(reportOutput, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  `inputRows=${inputRows} keptRows=${cleaned.length} distinctSourceKeys=${sourceKeys.size} distinctIdcodes=${idcodes.size}`
);
