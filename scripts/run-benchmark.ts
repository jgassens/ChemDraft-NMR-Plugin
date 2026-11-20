/**
 * Leakage-free accuracy benchmark against a raw NMReDATA export (ADR-0026).
 *
 *   npx tsx examples/plugins/nmr-predictor/scripts/run-benchmark.ts <input.sd> \
 *     [--hold-out-per-mille 20] [--seed 1] [--min-observations 5] [--statistic median] [--json out.json]
 *
 * Protocol: split the corpus by structure identity (OCL idcode — duplicate records of a compound
 * always land together), build the reference database from the TRAIN side only with the production
 * prune, then score every held-out assignment through the production lookup path. Nothing is tuned
 * against the held-out set. For a ~280 MB corpus run with NODE_OPTIONS=--max-old-space-size=6144.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";

import {
  aggregateBenchmark,
  bootstrapPhosphorusErrors,
  evaluateHeldOut,
  PHOSPHORUS_BOOTSTRAP_RESAMPLES,
  PHOSPHORUS_BOOTSTRAP_SEED,
  PHOSPHORUS_HOLD_OUT_PER_MILLE,
  splitCorpusBySourceReference,
  splitCorpusByStructure
} from "../src/providers/ocl/benchmark";
import { buildNmrDatabase, buildNmrDatabaseFromRecords } from "../src/providers/ocl/buildDatabase";
import { parseNmredataRecord, parseNmredataRecords } from "../src/providers/ocl/nmredata";
import { ILM_P31_PROVENANCE, readIlmP31Metadata, readSdfDirectory } from "./ilm-nmr-p31";

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const [, value] = args.splice(index, 2);
  return value;
}

const args = process.argv.slice(2);
const holdOutFlag = flagValue(args, "--hold-out-per-mille");
const seedFlag = flagValue(args, "--seed");
const minObservationsFlag = flagValue(args, "--min-observations");
const metadataPath = flagValue(args, "--metadata");
const holdOutPerMille = Number(holdOutFlag ?? 20);
const seed = Number(seedFlag ?? 1);
const minObservations = Number(minObservationsFlag ?? 5);
const statistic = (flagValue(args, "--statistic") ?? "median") as "median" | "mean";
const jsonOut = flagValue(args, "--json");
const [input] = args;
if (!input || !Number.isInteger(holdOutPerMille) || holdOutPerMille < 1 || holdOutPerMille > 500) {
  console.error(
    "usage: run-benchmark <input.sd> [--hold-out-per-mille 1..500] [--seed N] [--min-observations N] [--statistic median|mean] [--json out.json]\n" +
    "       run-benchmark <31P-SDF-directory> --metadata <Ilm-NMR-P31.csv> [--json out.json]"
  );
  process.exit(1);
}

if (statSync(input).isDirectory()) {
  if (!metadataPath || holdOutFlag !== undefined || seedFlag !== undefined ||
      minObservationsFlag !== undefined || statistic !== "median") {
    console.error("The 31P benchmark requires --metadata <Ilm-NMR-P31.csv> and uses its fixed split and lookup settings.");
    process.exit(1);
  }
  runPhosphorusBenchmark(input, metadataPath, jsonOut);
} else {
  runLegacyBenchmark(input);
}

function runLegacyBenchmark(input: string): void {
  const rawBytes = readFileSync(input);
  const inputSha256 = createHash("sha256").update(rawBytes).digest("hex");
  console.log(`corpus sha256=${inputSha256} bytes=${rawBytes.byteLength}`);

  const records = parseNmredataRecords(rawBytes.toString("utf8").replace(/\r\n?/g, "\n"));
  console.log(`usable records=${records.length}`);

  const split = splitCorpusByStructure(records, { holdOutPerMille, seed });
  console.log(
    `split: train=${split.train.length} heldOut=${split.heldOut.length} unparseable(kept in train)=${split.unparseable} seed=${seed} perMille=${holdOutPerMille}`
  );

  const database = buildNmrDatabase(split.train.map((record) => record.raw).join("\n$$$$\n"), {
    nuclei: ["1H", "13C"],
    minObservations,
    provenance: {
      name: "benchmark train split",
      version: `seed ${seed}, hold-out ${holdOutPerMille}/1000`,
      source: input,
      license: "nmrshiftdb2 Database License (ODbL-derived)",
      attribution: "Shift data © nmrshiftdb2 contributors.",
      note: "Train-only database for the leakage-free benchmark; never shipped.",
      inputSha256,
      inputBytes: rawBytes.byteLength
    }
  });
  console.log(
    `train database: entries=${database.provenance.entryCount} (raw ${database.provenance.rawEntryCount ?? database.provenance.entryCount}) structures=${database.provenance.structureCount}`
  );

  const rows = evaluateHeldOut(database, split.heldOut, { statistic, nuclei: ["1H", "13C"] });
  const summary = aggregateBenchmark(rows);

  for (const [nucleus, stats] of Object.entries(summary)) {
    console.log(`\n## ${nucleus} — ${stats.structures} structures, ${stats.assigned} assigned shifts`);
    console.log(
      `coverage ${(stats.coverage * 100).toFixed(1)}% (${stats.matched}/${stats.assigned}) · MAE ${stats.hose.mae} · median |Δ| ${stats.hose.medianAe} · P90 ${stats.hose.p90Ae} ppm`
    );
    for (const [tier, tierStats] of Object.entries(stats.byTier)) {
      console.log(
        `  ${tier.padEnd(6)} n=${String(tierStats.count).padStart(6)} MAE ${tierStats.mae} · median ${tierStats.medianAe} · P90 ${tierStats.p90Ae}`
      );
    }
    const comparison = stats.incrementComparison;
    if (comparison) {
      console.log(
        `  increment comparison (both defined, n=${comparison.count}): HOSE MAE ${comparison.hose.mae} vs increment MAE ${comparison.increment.mae}`
      );
      if (comparison.lowTier) {
        console.log(
          `    low-tier subset (n=${comparison.lowTier.count}): HOSE MAE ${comparison.lowTier.hose.mae} vs increment MAE ${comparison.lowTier.increment.mae}`
        );
      }
    }
  }

  if (jsonOut) {
    writeFileSync(
      jsonOut,
      `${JSON.stringify(
        {
          protocol: {
            inputSha256,
            inputBytes: rawBytes.byteLength,
            holdOutPerMille,
            seed,
            minObservations,
            statistic,
            usableRecords: records.length,
            train: split.train.length,
            heldOut: split.heldOut.length,
            unparseable: split.unparseable,
            trainDatabaseEntries: database.provenance.entryCount
          },
          summary
        },
        null,
        2
      )}\n`
    );
    console.log(`\nwrote ${jsonOut}`);
  }
}

function runPhosphorusBenchmark(directory: string, metadataPath: string, jsonOut?: string): void {
  const metadata = readIlmP31Metadata(metadataPath);
  const corpus = readSdfDirectory(directory);
  const entries = corpus.entries.map((entry) => {
    const row = metadata.get(entry.stem);
    if (!row) throw new Error(`Missing metadata row for SDF entry ${entry.stem}`);
    return { ...entry, ...row };
  });
  const { train, heldOut, droppedTrainingDuplicates } = splitCorpusBySourceReference(entries);
  const { inputSha256, inputBytes } = corpus;
  const database = buildNmrDatabaseFromRecords(train.map(({ raw }) => raw), {
    nuclei: ["31P"],
    provenance: { ...ILM_P31_PROVENANCE, note: "Train-only ³¹P benchmark table.", inputSha256, inputBytes }
  });
  const heldOutRecords = heldOut.flatMap(({ entry, groupKey }) => {
    const record = parseNmredataRecord(entry.raw);
    return record ? [{ record, groupKey }] : [];
  });
  const groupKeys = heldOutRecords.map(({ groupKey }) => groupKey);
  const rows = evaluateHeldOut(database, heldOutRecords.map(({ record }) => record), { nuclei: ["31P"] });
  const hasSolvent = ({ solvent }: { solvent: string }) => !["", "na"].includes(solvent.trim().toLowerCase());
  const output = `${JSON.stringify({
    protocol: {
      inputSha256,
      inputBytes,
      partition: "held-out source references, 10%, molecule-deduplicated",
      holdOutPerMille: PHOSPHORUS_HOLD_OUT_PER_MILLE,
      entries: entries.length,
      train: train.length,
      heldOut: heldOut.length,
      heldOutRecords: heldOutRecords.length,
      heldOutSourceGroups: new Set(heldOut.map(({ groupKey }) => groupKey)).size,
      droppedTrainingDuplicates,
      trainDatabaseEntries: database.provenance.entryCount,
      trainDatabaseStructures: database.provenance.structureCount,
      trainWithSolvent: train.filter(hasSolvent).length,
      heldOutWithSolvent: heldOut.filter(({ entry }) => hasSolvent(entry)).length,
      minObservations: 1,
      statistic: "median",
      bootstrapResamples: PHOSPHORUS_BOOTSTRAP_RESAMPLES,
      bootstrapSeed: PHOSPHORUS_BOOTSTRAP_SEED
    },
    summary: aggregateBenchmark(rows),
    bootstrap95: bootstrapPhosphorusErrors(rows, groupKeys)
  }, null, 2)}\n`;
  if (jsonOut) writeFileSync(jsonOut, output);
  process.stdout.write(output);
}
