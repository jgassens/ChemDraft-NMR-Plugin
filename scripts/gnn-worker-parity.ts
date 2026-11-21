/**
 * Worker-path feature parity: the features the plugin's worker computes at prediction time equal the
 * features the GNN was trained on, byte for byte, on the experiment's validation partition.
 *
 *   node --import tsx scripts/gnn-worker-parity.ts --extract <run>/extract --split <run>/split/split.json \
 *     [--partition val] [--fixture src/tests/fixtures/gnn-worker-parity.json] [--write-fixture]
 *
 * Inputs (read only): the experiment's `extract/records.jsonl` (molfile per record), its canonical
 * training dump `extract/features.jsonl`, and the registered `split.json`. For every record of the
 * partition, the script sends the record's molfile through the plugin's worker message handler
 * (`createNmrWorkerHandler`, with structured cloning, as the Web Worker does) to the production
 * predictor (`GnnShiftPredictor`). The predictor's features observer records exactly what that path
 * featurized; a stand-in model records the tensors the model would receive. The script checks, per
 * record:
 *
 * - the canonical line of the worker-path features (or its error code) equals the training dump's
 *   line for that record, byte for byte;
 * - the tensors handed to the model equal `packGnnInputs` of the training line's features.
 *
 * It prints a JSON summary with the SHA-256 of the partition's training lines (header plus lines,
 * in record order) and of the worker-path lines, and exits 2 on any difference. `--fixture` also
 * checks the committed fixture's validation hash and its hand-picked hard cases (identifiers and
 * line hashes only; no corpus records are committed). `--write-fixture` rewrites the fixture's
 * `validation` block and hard-case list from this run, keeping its `synthetic` cases.
 */
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

import type { NmrPredictionRequest } from "../src/domain/contracts";
import {
  canonicalDumpHeader,
  canonicalErrorLine,
  canonicalFeatureLine,
  molfileStructureInput,
  sha256Hex
} from "../src/providers/gnn/canonicalDump";
import { assessNode, describeNode, heavyAtomCount } from "../src/providers/gnn/domainRules";
import { GNN_ATOM_FEATURE_NAMES, GNN_BOND_FEATURE_NAMES, type GnnMoleculeFeatures } from "../src/providers/gnn/featurize";
import { GnnShiftPredictor } from "../src/providers/gnn/GnnShiftPredictor";
import type { GnnModelInput, GnnModelProvider } from "../src/providers/gnn/runtime";
import { packGnnInputs, type GnnInputTensors } from "../src/providers/gnn/tensors";
import { GNN_TRAINING_DOMAIN } from "../src/providers/gnn/trainingDomain";
import { createNmrWorkerHandler } from "../src/worker/nmrWorkerCore";
import type { NmrWorkerResponse } from "../src/worker/protocol";

interface Arguments {
  extract: string;
  split: string;
  partition: string;
  fixture?: string;
  writeFixture: boolean;
}

function parseArguments(argv: string[]): Arguments {
  const take = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const extract = take("--extract");
  const split = take("--split");
  if (!extract || !split) {
    console.error("usage: gnn-worker-parity --extract <dir> --split <split.json> [--partition val] [--fixture <json>] [--write-fixture]");
    process.exit(1);
  }
  return { extract, split, partition: take("--partition") ?? "val", fixture: take("--fixture"), writeFixture: argv.includes("--write-fixture") };
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function* lines(path: string): AsyncGenerator<string> {
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) yield line;
}

/** The worker message path, with a features observer and a stand-in model that records its input. */
function workerPath() {
  let observed: { features: GnnMoleculeFeatures } | { error: string } | undefined;
  const modelInputs: GnnModelInput[] = [];
  const models: GnnModelProvider = {
    load: async (nucleus) => ({
      status: "ready",
      model: {
        nucleus,
        sha256: "parity-probe",
        run: async (input) => {
          modelInputs.push(structuredClone(input));
          return new Float32Array(input.tensors.atomCount);
        }
      }
    })
  };
  const responses: NmrWorkerResponse[] = [];
  const handle = createNmrWorkerHandler((response) => responses.push(structuredClone(response)), {
    createPredictor: () => new GnnShiftPredictor({ models, onFeatures: (outcome) => (observed = outcome) })
  });
  let next = 0;
  return async (molfile: string) => {
    observed = undefined;
    modelInputs.length = 0;
    const requestId = `parity-${next++}`;
    const request: NmrPredictionRequest = {
      structure: molfileStructureInput(molfile),
      nuclei: ["13C"],
      options: { statistic: "median", hoseLevels: [4, 3, 2, 1], ignoreLabileHydrogens: true }
    };
    handle({ type: "predict", requestId, request, sourceFingerprint: requestId });
    let response: NmrWorkerResponse | undefined;
    while (!(response = responses.find((candidate) => candidate.requestId === requestId))) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    responses.length = 0;
    return { response, observed, modelInputs: [...modelInputs] };
  };
}

function sameTensors(a: GnnInputTensors, b: GnnInputTensors): boolean {
  const same = (x: ArrayLike<number>, y: ArrayLike<number>) => x.length === y.length && Array.prototype.every.call(x, (v: number, i: number) => v === y[i]);
  return a.atomCount === b.atomCount && a.degree === b.degree && same(a.atoms, b.atoms) && same(a.neighbor, b.neighbor) &&
    same(a.bonds, b.bonds) && same(a.mask, b.mask);
}

/** Hard-case categories, read from the training features only. */
function categories(features: GnnMoleculeFeatures | undefined): string[] {
  if (!features) return ["featurizer-error"];
  const atom = (name: string) => GNN_ATOM_FEATURE_NAMES.indexOf(name);
  const bond = (name: string) => GNN_BOND_FEATURE_NAMES.indexOf(name);
  const rows = features.atoms;
  const found = new Set<string>();
  if (rows.some((row) => row[atom("formalCharge")] !== 0)) found.add("charged");
  if (rows.some((row) => row[atom("aromatic")] === 1 && ["N", "O", "S", "Se"].includes(describeNode(row).element))) found.add("aromatic-heterocycle");
  if (rows.some((row) => row[atom("atomCIP=R")] === 1 || row[atom("atomCIP=S")] === 1)) found.add("stereo-center");
  if (features.bonds.some((b) => b.features[bond("bondCIP=E")] === 1 || b.features[bond("bondCIP=Z")] === 1)) found.add("stereo-double-bond");
  if (rows.some((row) => row[atom("atomCIP=unknown")] === 1)) found.add("stereo-unknown");
  if (rows.some((row) => row[atom("isotopeLabeled")] === 1 || row[atom("attachedDeuterium/4")] > 0 || row[atom("attachedTritium/4")] > 0)) found.add("isotope");
  if (rows.some((row) => row[atom("radical=none")] !== 1)) found.add("radical");
  const declines = new Set(rows.flatMap((_, node) => assessNode(features, node, GNN_TRAINING_DOMAIN).declines));
  if (declines.has("element")) found.add("declined-element");
  if (declines.has("charge_radical")) found.add("declined-charge-radical");
  if (heavyAtomCount(features) > GNN_TRAINING_DOMAIN.size_limit) found.add("declined-size");
  return [...found];
}

const PER_CATEGORY = 4;

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const recordsPath = join(args.extract, "records.jsonl");
  const featuresPath = join(args.extract, "features.jsonl");
  const split = JSON.parse(readFileSync(args.split, "utf8")) as { records: { record: number; partition: string }[] };
  const members = new Set(split.records.filter((row) => row.partition === args.partition).map((row) => row.record));
  if (members.size === 0) throw new Error(`split has no ${args.partition} records`);

  const molfiles = new Map<number, string>();
  for await (const line of lines(recordsPath)) {
    const prefix = '{"record":';
    const record = Number(line.slice(prefix.length, line.indexOf(",")));
    if (members.has(record)) molfiles.set(record, (JSON.parse(line) as { molfile: string }).molfile);
  }
  const trainingLines = new Map<number, string>();
  let header: string | undefined;
  for await (const line of lines(featuresPath)) {
    if (header === undefined) {
      header = `${line}\n`;
      continue;
    }
    const prefix = '{"index":';
    const record = Number(line.slice(prefix.length, line.indexOf(",")));
    if (members.has(record)) trainingLines.set(record, `${line}\n`);
  }
  if (header !== canonicalDumpHeader()) throw new Error("features.jsonl header differs from this plugin's schema-1 header");

  const run = workerPath();
  const ordered = [...members].sort((a, b) => a - b);
  const mismatches: { record: number; reason: string }[] = [];
  const workerLines: string[] = [];
  const picks: Record<string, { record: number; molfileSha256: string | null; lineSha256: string }[]> = {};
  let featurized = 0;
  let modelRuns = 0;
  for (const record of ordered) {
    const molfile = molfiles.get(record);
    const expected = trainingLines.get(record);
    if (molfile === undefined || expected === undefined) {
      mismatches.push({ record, reason: "missing from records.jsonl or features.jsonl" });
      continue;
    }
    const training = JSON.parse(expected) as GnnMoleculeFeatures & { molfileSha256: string | null; error?: string };
    const molfileSha256 = await sha256Hex(molfile);
    if (training.molfileSha256 !== molfileSha256) mismatches.push({ record, reason: "molfile SHA-256 differs from the dump" });
    const identity = { index: record, molfileSha256 };
    const { response, observed, modelInputs } = await run(molfile);
    let line: string;
    if (observed && "features" in observed) {
      line = canonicalFeatureLine(identity, observed.features);
      featurized += 1;
    } else if (observed) {
      line = canonicalErrorLine(identity, observed.error);
    } else if (response.type === "error") {
      // The structure failed to parse before featurization; the dump records the same error code.
      line = canonicalErrorLine(identity, response.error.code);
    } else {
      line = "";
      mismatches.push({ record, reason: `no features observed (${response.type})` });
    }
    workerLines.push(line);
    if (line !== expected) mismatches.push({ record, reason: "canonical line differs" });
    if (training.error === undefined) {
      const trainingTensors = packGnnInputs(training);
      for (const input of modelInputs) {
        modelRuns += 1;
        if (!sameTensors(input.tensors, trainingTensors)) mismatches.push({ record, reason: "model input tensors differ" });
      }
    }
    for (const category of categories(training.error === undefined ? training : undefined)) {
      const list = (picks[category] ??= []);
      if (list.length < PER_CATEGORY) {
        list.push({ record, molfileSha256: training.molfileSha256, lineSha256: await sha256Hex(expected) });
      }
    }
  }

  const expectedSha256 = await sha256Hex(header + ordered.map((record) => trainingLines.get(record) ?? "").join(""));
  const workerSha256 = await sha256Hex(header + workerLines.join(""));
  const summary = {
    parity: "worker-path",
    partition: args.partition,
    records: ordered.length,
    featurized,
    errors: ordered.length - featurized,
    modelRuns,
    expectedSha256,
    workerSha256,
    passed: mismatches.length === 0 && expectedSha256 === workerSha256,
    mismatches: mismatches.slice(0, 50),
    mismatchCount: mismatches.length
  };

  if (args.fixture) {
    const fixture = JSON.parse(readFileSync(args.fixture, "utf8"));
    const sources = {
      records_sha256: await fileSha256(recordsPath),
      split_sha256: await fileSha256(args.split),
      features_dump_sha256: await fileSha256(featuresPath)
    };
    if (args.writeFixture) {
      fixture.sources = sources;
      fixture.validation = {
        partition: args.partition,
        records: ordered.length,
        featurized,
        dumpSha256: expectedSha256,
        workerPathSha256: workerSha256,
        passed: summary.passed
      };
      fixture.validationHardCases = Object.entries(picks)
        .sort(([a], [b]) => a.localeCompare(b))
        .flatMap(([category, list]) => list.map((item) => ({ category, ...item })));
      writeFileSync(args.fixture, `${JSON.stringify(fixture, null, 2)}\n`);
    } else {
      const problems: string[] = [];
      for (const [key, value] of Object.entries(sources)) {
        if (fixture.sources?.[key] !== value) problems.push(`source ${key} ${value} differs from the fixture`);
      }
      if (fixture.validation?.dumpSha256 !== workerSha256) problems.push("worker-path SHA-256 differs from the fixture's validation dump");
      const byRecord = new Map(ordered.map((record, index) => [record, workerLines[index]]));
      for (const item of fixture.validationHardCases ?? []) {
        const line = byRecord.get(item.record);
        if (line === undefined || (await sha256Hex(line)) !== item.lineSha256) problems.push(`hard case ${item.category}/${item.record} differs`);
      }
      Object.assign(summary, { fixtureProblems: problems, passed: summary.passed && problems.length === 0 });
    }
  }
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.passed) process.exit(2);
}

await main();
