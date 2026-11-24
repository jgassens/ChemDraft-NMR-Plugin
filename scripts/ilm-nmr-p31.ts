import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const ILM_P31_PROVENANCE = {
  name: "Ilm-NMR-P31 (GitHub clacor/Ilm-NMR-P31 @ ead6f91)",
  version: "ead6f914d2bdfb60e4befea72ea503d32978d358",
  source: "https://github.com/clacor/Ilm-NMR-P31/tree/ead6f914d2bdfb60e4befea72ea503d32978d358",
  // Same strings as package.json dataLicenses (the source of truth). The data is CC BY 4.0;
  // BSD-3-Clause is the GitHub copy's own license, credited in the license string and notice.
  license: "CC-BY-4.0 (Ilm-NMR-P31 v3.0, doi:10.5281/zenodo.20762603); the GitHub copy's own license is BSD-3-Clause",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  attribution: "Geitner, R. (2026), Ilm-NMR-P31 v3.0, Zenodo, doi:10.5281/zenodo.20762603, CC BY 4.0 (BSD-3-Clause, copyright (c) 2026 Robert Geitner, kept for the GitHub copy). Includes data from NMRexp: Wang, J.-J. and Zhu, R. (2025), doi:10.5281/zenodo.17296666, CC BY 4.0. Filtered and transformed into aggregated HOSE shift statistics.",
  note: "Aggregated ³¹P HOSE environment shift statistics from all Ilm-NMR-P31 SDF entries."
};

/** Hash the file bytes in filename byte order, inserting only missing terminators or linefeeds.
 * Decode for NMReDATA parsing separately so line-ending normalization cannot affect provenance. */
export function readSdfDirectory(directory: string) {
  const filenames = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sdf"))
    .map((entry) => entry.name)
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  if (filenames.length === 0) throw new Error("The SDF directory is empty");

  const hash = createHash("sha256");
  let inputBytes = 0;
  const entries = filenames.map((filename) => {
    const bytes = readFileSync(join(directory, filename));
    const raw = bytes.toString("utf8");
    const linefeed = raw.endsWith("\n") ? "" : "\n";
    const terminator = /(?:^|\n)\$\$\$\$[\t \r\n]*$/.test(raw) ? "" : "$$$$\n";
    const suffix = linefeed + terminator;
    hash.update(bytes).update(suffix);
    inputBytes += bytes.length + suffix.length;
    return { stem: filename.slice(0, -4), raw: realignV2000AtomFields((raw + suffix).replace(/\r\n?/g, "\n")) };
  });
  return { entries, inputSha256: hash.digest("hex"), inputBytes };
}

/** Some exports insert an extra column in the fixed-width V2000 atom block. Re-pad the same
 * fields for OCL, retaining the coordinate columns, atom order, bond block, and NMReDATA tags. */
function realignV2000AtomFields(raw: string): string {
  const lines = raw.split("\n");
  const counts = lines[3];
  if (!counts?.includes("V2000")) return raw;
  const atomCount = Number(counts.slice(0, 3));
  const atomLines = lines.slice(4, 4 + atomCount);
  if (!atomLines.some((line) => line.trimEnd().length > 69)) return raw;

  for (const [index, line] of atomLines.entries()) {
    const [element, mass, ...fields] = line.slice(30).trim().split(/\s+/);
    if (element.length > 3 || !mass || mass.length > 2 || fields.length !== 11 ||
        fields.some((field) => field.length > 3 || !/^-?\d+$/.test(field))) return raw;
    lines[index + 4] = `${line.slice(0, 30)} ${element.padEnd(3)}${mass.padStart(2)}${fields.map((field) => field.padStart(3)).join("")}`;
  }
  return lines.join("\n");
}

interface EntryMetadata {
  ref: string;
  solvent: string;
}

/** R write.table leaves the row-name column off the header. The pinned export stores the SDF ID
 * in `num` and uses numeric row names. Exports without `num` can put the ID in the row name. */
export function readIlmP31Metadata(path: string): Map<string, EntryMetadata> {
  const [header, ...rows] = readFileSync(path, "utf8").trimEnd().split(/\r?\n/);
  const columns = parseFields(header);
  const ref = columns.indexOf("ref") + 1;
  const solvent = columns.indexOf("LM") + 1;
  const id = columns.indexOf("num") + 1;
  if (!ref || !solvent) throw new Error("Ilm-NMR-P31 metadata requires ref and LM columns");

  const metadata = new Map<string, EntryMetadata>();
  for (const [index, row] of rows.entries()) {
    const fields = parseFields(row);
    const stem = fields[id];
    if (fields.length !== columns.length + 1 || !stem || metadata.has(stem)) {
      throw new Error(`Invalid or duplicate metadata entry on line ${index + 2}`);
    }
    metadata.set(stem, { ref: fields[ref], solvent: fields[solvent] });
  }
  return metadata;
}

function parseFields(line: string): string[] {
  return [...line.matchAll(/"((?:\\.|[^"\\])*)"|([^\s"]+)/g)]
    .map(([, quoted, bare]) => quoted === undefined ? bare : quoted.replace(/\\(["\\])/g, "$1"));
}
