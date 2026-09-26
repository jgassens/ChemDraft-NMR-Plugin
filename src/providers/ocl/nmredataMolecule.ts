import * as OCL from "openchemlib";

export interface IndexedNmredataMolecule {
  molecule: OCL.Molecule;
  /** NMReDATA atom reference → OCL atom index in `molecule`. V2000 references are 1-based atom
   * positions; V3000 references are the explicit (possibly nonconsecutive) atom IDs. */
  oclAtomByMolfileIndex: ReadonlyMap<number, number>;
}

/**
 * Parse an NMReDATA molfile and map the atom numbers cited by its assignments onto OCL atom indices.
 * The NMReDATA wording and this repository's parser describe these as molfile atom numbers. That is
 * unambiguous for the NMRShiftDB2 NMReDATA export, whose records are V2000: they are 1-based atom
 * positions. The repository contains no V3000 corpus records, so for V3000 we explicitly interpret
 * "atom number" as the CTAB atom ID, rather than its ordinal position in the atom block.
 *
 * OCL reorders atoms while parsing (explicit H are swapped to the end, which also moves the heavy
 * atom they traded places with), so numbers cannot be tagged after parsing. Instead each atom's
 * source reference is written into the atom-atom mapping field first; OCL carries mapping numbers
 * through the reorder. Returns undefined when the molfile cannot be parsed or the mapping is not
 * one-to-one.
 */
export function parseNmredataMolecule(molfile: string): IndexedNmredataMolecule | undefined {
  // `padEnd()` on a short CRLF V2000 atom line would otherwise leave the carriage return before the
  // inserted map field, causing OCL to stop parsing the line before it reaches the stamp.
  const stamped = stampMolfileAtomIndexes(molfile.replace(/\r\n?/g, "\n"));
  if (!stamped) return undefined;

  let molecule: OCL.Molecule;
  try {
    molecule = OCL.Molecule.fromMolfile(stamped.molfile);
  } catch {
    return undefined;
  }
  if (molecule.getAllAtoms() === 0 || molecule.getAllAtoms() !== stamped.atomReferences.size) return undefined;
  molecule.ensureHelperArrays(OCL.Molecule.cHelperRings);

  const oclAtomByMolfileIndex = new Map<number, number>();
  for (let atom = 0; atom < molecule.getAllAtoms(); atom += 1) {
    const molfileIndex = molecule.getAtomMapNo(atom);
    if (!stamped.atomReferences.has(molfileIndex) || oclAtomByMolfileIndex.has(molfileIndex)) {
      return undefined;
    }
    oclAtomByMolfileIndex.set(molfileIndex, atom);
  }
  return { molecule, oclAtomByMolfileIndex };
}

interface StampedMolfile {
  molfile: string;
  atomReferences: ReadonlySet<number>;
}

function stampMolfileAtomIndexes(molfile: string): StampedMolfile | undefined {
  const lines = molfile.split("\n");
  const countsIndex = lines.findIndex((line) => /V2000|V3000/.test(line));
  if (countsIndex < 0) return undefined;
  return /V3000/.test(lines[countsIndex])
    ? stampV3000(lines)
    : stampV2000(lines, countsIndex);
}

/** V2000 atom line: the atom-atom mapping number occupies columns 61–63 (0-based 60–62). */
function stampV2000(lines: string[], countsIndex: number): StampedMolfile | undefined {
  const atomCount = Number(lines[countsIndex].slice(0, 3));
  if (!Number.isInteger(atomCount) || atomCount <= 0 || countsIndex + atomCount >= lines.length) return undefined;
  const out = [...lines];
  for (let index = 1; index <= atomCount; index += 1) {
    const line = out[countsIndex + index].padEnd(69, " ");
    out[countsIndex + index] = `${line.slice(0, 60)}${String(index).padStart(3)}${line.slice(63)}`;
  }
  return {
    molfile: out.join("\n"),
    atomReferences: new Set(Array.from({ length: atomCount }, (_, index) => index + 1))
  };
}

const V3000_PREFIX = "M  V30 ";

/**
 * V3000 atom line: `M  V30 id type x y z aamap [props]`. Physical continuation lines are assembled
 * first, then the logical record is tokenized so quoted values, bracketed atom lists and grouped
 * key=value properties stay intact. The aamap is set to the explicit atom ID.
 */
function stampV3000(lines: string[]): StampedMolfile | undefined {
  const out = assembleV3000LogicalLines(lines);
  if (!out) return undefined;

  let inAtomBlock = false;
  const atomReferences = new Set<number>();
  for (let row = 0; row < out.length; row += 1) {
    const line = out[row];
    if (/^M {2}V30 BEGIN ATOM/.test(line)) {
      inAtomBlock = true;
      continue;
    }
    if (/^M {2}V30 END ATOM/.test(line)) break;
    if (!inAtomBlock || !line.startsWith(V3000_PREFIX)) continue;

    const fields = tokenizeV3000Record(line.slice(V3000_PREFIX.length));
    if (!fields) return undefined;
    const atomId = Number(fields[0]);
    // `NOT [C,N]` is a two-token atom type; bracketed lists without NOT are one token.
    const mapField = fields[1]?.toUpperCase() === "NOT" ? 6 : 5;
    if (
      !Number.isInteger(atomId) ||
      atomId <= 0 ||
      atomReferences.has(atomId) ||
      fields.length <= mapField ||
      !fields.slice(mapField - 3, mapField).every((coordinate) => Number.isFinite(Number(coordinate)))
    ) {
      return undefined;
    }
    atomReferences.add(atomId);
    fields[mapField] = String(atomId);
    out[row] = `${V3000_PREFIX}${fields.join(" ")}`;
  }
  return atomReferences.size > 0 ? { molfile: out.join("\n"), atomReferences } : undefined;
}

/** Collapse V3000 physical continuations without guessing token boundaries: whitespace before the
 * trailing `-` is retained, while a split token (no preceding whitespace) is joined directly. */
function assembleV3000LogicalLines(lines: readonly string[]): string[] | undefined {
  const logical: string[] = [];
  for (let row = 0; row < lines.length; row += 1) {
    const line = lines[row];
    if (!line.startsWith(V3000_PREFIX)) {
      logical.push(line);
      continue;
    }

    let content = line.slice(V3000_PREFIX.length);
    while (content.trimEnd().endsWith("-")) {
      const marker = content.trimEnd().length - 1;
      content = content.slice(0, marker);
      row += 1;
      const continuation = lines[row];
      if (continuation === undefined || !continuation.startsWith(V3000_PREFIX)) return undefined;
      content += continuation.slice(V3000_PREFIX.length);
    }
    logical.push(`${V3000_PREFIX}${content.trimEnd()}`);
  }
  return logical;
}

/** Tokenize one logical V3000 record, treating whitespace inside quotes, `[...]`, and `(...)` as
 * data. This preserves constructs such as `NOT [C,N]`, `LABEL="quoted value"`, and
 * `ATOMS=(3 10 20 30)` when the stamped record is serialized again. */
function tokenizeV3000Record(record: string): string[] | undefined {
  const tokens: string[] = [];
  let start = -1;
  let bracketDepth = 0;
  let parenthesisDepth = 0;
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < record.length; index += 1) {
    const character = record[index];
    if (start < 0) {
      if (/\s/.test(character)) continue;
      start = index;
    }

    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === "[") bracketDepth += 1;
    else if (character === "]") bracketDepth -= 1;
    else if (character === "(") parenthesisDepth += 1;
    else if (character === ")") parenthesisDepth -= 1;

    if (bracketDepth < 0 || parenthesisDepth < 0) return undefined;
    if (/\s/.test(character) && bracketDepth === 0 && parenthesisDepth === 0) {
      tokens.push(record.slice(start, index));
      start = -1;
    }
  }

  if (quoted || bracketDepth !== 0 || parenthesisDepth !== 0) return undefined;
  if (start >= 0) tokens.push(record.slice(start));
  return tokens;
}
