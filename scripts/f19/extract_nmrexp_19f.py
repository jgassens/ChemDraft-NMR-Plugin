"""Extract the 19F NMR rows of the NMRexp parquet (docs/f19-benchmark.md section 2, step 1).

    python3 scripts/f19/extract_nmrexp_19f.py <NMRexp.parquet> <out.jsonl>

Needs pyarrow; everything else is the standard library. Python 3.9+.

Keeps rows whose NMR_type is exactly "19F NMR" and writes one JSON object per kept row:
{"row", "filename", "smiles", "solvent", "peaks", "parseError"}. "row" is the 0-based row index
in the parquet. NMR_processed is parsed with ast.literal_eval (a literal parser; it never runs
code). "peaks" is each tuple's first element: a JSON number, a JSON list (its items converted the
same way), or null for anything else (strings, booleans, tuples, non-finite numbers), which the
cleaner then drops as an unrecognized peak shape. A value that does not parse, or is not a list of
non-empty tuples, gives "peaks": null and a "parseError" naming the shape. No chemistry is done here.
Only counts are printed (to stderr).
"""

import ast
import json
import math
import sys

import pyarrow.parquet as pq

COLUMNS = ["Filename", "SMILES", "NMR_type", "NMR_solvent", "NMR_processed"]
NMR_TYPE = "19F NMR"


def shift_element(value):
    """A tuple's first element as JSON: number, list of converted items, or None."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, list):
        return [shift_element(item) for item in value]
    return None


def parse_peaks(text):
    """Return (peaks, parse_error). Exactly one of them is None."""
    if text is None:
        return None, "missing"
    if not isinstance(text, str):
        return None, "not-a-string"
    try:
        value = ast.literal_eval(text)
    except (ValueError, SyntaxError, TypeError, MemoryError, RecursionError):
        return None, "not-a-python-literal"
    if not isinstance(value, list):
        return None, "not-a-list"
    peaks = []
    for item in value:
        if not isinstance(item, tuple):
            return None, "list-item-not-a-tuple"
        if len(item) == 0:
            return None, "empty-tuple"
        peaks.append(shift_element(item[0]))
    return peaks, None


def main(argv):
    if len(argv) != 3:
        sys.stderr.write("usage: extract_nmrexp_19f.py <parquet> <out.jsonl>\n")
        return 1
    source, output = argv[1], argv[2]
    parquet = pq.ParquetFile(source)
    total = 0
    kept = 0
    errors = {}
    with open(output, "w", encoding="utf-8", newline="\n") as out:
        for batch in parquet.iter_batches(columns=COLUMNS, batch_size=65536):
            columns = {name: batch.column(name).to_pylist() for name in COLUMNS}
            for offset in range(batch.num_rows):
                row = total + offset
                if columns["NMR_type"][offset] != NMR_TYPE:
                    continue
                peaks, error = parse_peaks(columns["NMR_processed"][offset])
                if error is not None:
                    errors[error] = errors.get(error, 0) + 1
                record = {
                    "row": row,
                    "filename": columns["Filename"][offset],
                    "smiles": columns["SMILES"][offset],
                    "solvent": columns["NMR_solvent"][offset],
                    "peaks": peaks,
                    "parseError": error,
                }
                out.write(json.dumps(record, ensure_ascii=False, allow_nan=False))
                out.write("\n")
                kept += 1
            total += batch.num_rows
    sys.stderr.write(json.dumps({"inputRows": total, "keptRows": kept, "parseErrors": errors}, sort_keys=True))
    sys.stderr.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
