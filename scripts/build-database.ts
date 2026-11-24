/**
 * Compile a NMReDATA/SDF export into predictor reference statistics.
 *
 *   node --import tsx scripts/build-database.ts <input.sd|31P-SDF-directory> <output.json> [--min-observations N]
 *
 * Input: an atom-assigned NMReDATA export (e.g. NMRShiftDB2's nmrshiftdb2rawdata.nmredata.sd).
 * Output: aggregated HOSE-code → shift statistics (JSON). Only statistics are written — never raw
 * structures — so the artifact is small and is a separate, attributed data asset (see ADR-0014).
 *
 * Reproducibility (report 0024): the SHA-256 and byte length of the exact input file are embedded in
 * the artifact's provenance alongside the prune rule, so `same input + same flags → same artifact`
 * is verifiable. Both bundled builds default to n >= 5.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";

import {
  buildNmrDatabase,
  buildNmrDatabaseFromRecords,
  PRODUCTION_MIN_OBSERVATIONS
} from "../src/providers/ocl/buildDatabase";
import { ILM_P31_PROVENANCE, readSdfDirectory } from "./ilm-nmr-p31";

const args = process.argv.slice(2);
const flagIndex = args.indexOf("--min-observations");
let minObservations: number | undefined;
if (flagIndex >= 0) {
  minObservations = Number(args[flagIndex + 1]);
  args.splice(flagIndex, 2);
}
const [input, output] = args;
minObservations ??= PRODUCTION_MIN_OBSERVATIONS;
if (!input || !output || !Number.isInteger(minObservations) || minObservations < 1) {
  console.error("usage: build-database <input.sd|31P-SDF-directory> <output.json> [--min-observations N>=1]");
  process.exit(1);
}

if (statSync(input).isDirectory()) {
  const { entries, inputSha256, inputBytes } = readSdfDirectory(input);
  const database = buildNmrDatabaseFromRecords(entries.map(({ raw }) => raw), {
    nuclei: ["31P"],
    minObservations,
    provenance: { ...ILM_P31_PROVENANCE, inputSha256, inputBytes }
  });
  writeFileSync(output, `${JSON.stringify(database)}\n`);
  console.log(JSON.stringify(database.provenance));
} else {
  const rawBytes = readFileSync(input);
  const inputSha256 = createHash("sha256").update(rawBytes).digest("hex");

  const database = buildNmrDatabase(rawBytes.toString("utf8"), {
    nuclei: ["1H", "13C"],
    minObservations,
    provenance: {
      name: "NMRShiftDB2 (full NMReDATA export)",
      version: "nmrshiftdb2.nmredata.sd",
      source: "https://sourceforge.net/projects/nmrshiftdb2/files/data/",
      license: "nmrshiftdb2 Database License (ODbL-derived)",
      licenseUrl: "https://nmrshiftdb.nmr.uni-koeln.de/nmrshiftdbhtml/nmrshiftdb2datalicense.txt",
      attribution:
        "Shift data © nmrshiftdb2 contributors, used under the nmrshiftdb2 Database License. Compiled HOSE-code statistics derived by ChemDraft.",
      note: "Aggregated ¹H/¹³C environment-code shift statistics from NMRShiftDB2 assignments (the database does not mark which are experimental).",
      inputSha256,
      inputBytes: rawBytes.byteLength
    }
  });

  // The human-readable note repeats the machine-recorded prune so the provenance panel tells the story.
  if (database.provenance.minObservations !== undefined) {
    database.provenance.note += ` Environments pruned to n>=${database.provenance.minObservations} observations for bundle size (from ${database.provenance.rawEntryCount} raw).`;
  }

  writeFileSync(output, `${JSON.stringify(database)}\n`);
  console.log(
    [
      `entries=${database.provenance.entryCount}`,
      `raw=${database.provenance.rawEntryCount ?? database.provenance.entryCount}`,
      `minObservations=${minObservations}`,
      `structures=${database.provenance.structureCount}`,
      `nuclei=${database.provenance.nuclei.join(",")}`,
      `inputSha256=${inputSha256}`,
      `inputBytes=${rawBytes.byteLength}`
    ].join(" ")
  );
}
