"""Extract the 19F NMR rows of the NMRexp parquet (docs/f19-benchmark.md section 2, step 1).

    python3 scripts/f19/extract_nmrexp_19f.py <NMRexp.parquet> <out.jsonl>

Needs pyarrow, imported only inside main() so the pure helpers below can be imported (and tested)
with the standard library alone. Python 3.9+.

Keeps rows whose NMR_type is exactly "19F NMR" and writes one JSON object per kept row:
{"row", "filename", "smiles", "solvent", "peaks"}. "row" is the 0-based row index in the parquet.
NMR_processed is parsed with ast.literal_eval (a literal parser; it never runs code) and must be a
list of (shift, multiplicity, J) tuples of exactly three elements. "peaks" is each tuple's first
element: a JSON number, a JSON list (its items converted the same way), or null for anything else
(strings, booleans, tuples, non-finite numbers), which the cleaner then drops as an unrecognized
peak shape. A value that does not parse, is not a list, or holds anything but three-element tuples
gives "peaks": null, which the cleaner drops. No chemistry is done here. Only counts are printed
(to stderr), including the number of parse failures by kind.
"""

import ast
import json
import math
import sys

COLUMNS = ["Filename", "SMILES", "NMR_type", "NMR_solvent", "NMR_processed"]
NMR_TYPE = "19F NMR"
TUPLE_LENGTH = 3


def is_19f_type(nmr_type):
    """Section 2 step 1: NMR_type exactly "19F NMR", no trimming or case folding."""
    return nmr_type == NMR_TYPE


def literal(text):
    """Parse a Python literal with ast.literal_eval; never evaluates code.

    Returns (value, None) or (None, error kind).
    """
    if text is None:
        return None, "missing"
    if not isinstance(text, str):
        return None, "not-a-string"
    try:
        return ast.literal_eval(text), None
    except (ValueError, SyntaxError, TypeError, MemoryError, RecursionError):
        return None, "not-a-python-literal"


def is_peak_tuple(item):
    """A (shift, multiplicity, J) entry: a tuple of exactly three elements."""
    return isinstance(item, tuple) and len(item) == TUPLE_LENGTH


def shift_element(value):
    """A tuple's first element as JSON: a number, a list of converted items, or None.

    A two-number list comes through as a list and is read as a range by the cleaner.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, list):
        return [shift_element(item) for item in value]
    return None


def peaks_from_value(value):
    """Return (peaks, error kind) for a parsed NMR_processed value. Exactly one is None."""
    if not isinstance(value, list):
        return None, "not-a-list"
    peaks = []
    for item in value:
        if not isinstance(item, tuple):
            return None, "list-item-not-a-tuple"
        if not is_peak_tuple(item):
            return None, "tuple-not-three-elements"
        peaks.append(shift_element(item[0]))
    return peaks, None


def parse_peaks(text):
    """Return (peaks, error kind) for a raw NMR_processed string. Exactly one is None."""
    value, error = literal(text)
    if error is not None:
        return None, error
    return peaks_from_value(value)


def main(argv):
    if len(argv) != 3:
        sys.stderr.write("usage: extract_nmrexp_19f.py <parquet> <out.jsonl>\n")
        return 1
    import pyarrow.parquet as pq

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
                if not is_19f_type(columns["NMR_type"][offset]):
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
