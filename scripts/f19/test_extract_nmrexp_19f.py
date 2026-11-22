"""Standard-library tests for the pure parts of extract_nmrexp_19f.py (no pyarrow needed).

    python3 -I -m unittest discover -s scripts/f19 -p 'test_*.py'
"""

import os
import sys
import tempfile
import unittest

import extract_nmrexp_19f as extract


class ImportTest(unittest.TestCase):
    def test_importing_does_not_load_pyarrow(self):
        self.assertNotIn("pyarrow", sys.modules)
        self.assertNotIn("pyarrow.parquet", sys.modules)


class NmrTypeTest(unittest.TestCase):
    def test_exact_match_only(self):
        self.assertTrue(extract.is_19f_type("19F NMR"))
        for other in ["19F", "19F NMR ", " 19F NMR", "19f nmr", "1H NMR", "13C NMR", "", None]:
            with self.subTest(nmr_type=other):
                self.assertFalse(extract.is_19f_type(other))


class LiteralOnlyTest(unittest.TestCase):
    def test_code_is_never_evaluated(self):
        self.assertEqual(extract.parse_peaks("__import__('os')"), (None, "not-a-python-literal"))

    def test_code_with_a_side_effect_has_no_effect(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = os.path.join(directory, "evaluated")
            text = "[(__import__('pathlib').Path(%r).touch(), 's', 0.0)]" % marker
            self.assertEqual(extract.parse_peaks(text), (None, "not-a-python-literal"))
            self.assertFalse(os.path.exists(marker))

    def test_unparseable_and_missing(self):
        self.assertEqual(extract.parse_peaks("[(-63.2, 's'"), (None, "not-a-python-literal"))
        self.assertEqual(extract.parse_peaks(None), (None, "missing"))
        self.assertEqual(extract.parse_peaks(b"[]"), (None, "not-a-string"))


class PeakShapeTest(unittest.TestCase):
    def test_numbers_are_kept(self):
        self.assertEqual(extract.parse_peaks("[(-63.2, 's', None)]"), ([-63.2], None))
        self.assertEqual(extract.parse_peaks("[(-120, 'd', 8.5), (-120.02, 'd', 8.5)]"), ([-120, -120.02], None))

    def test_two_number_lists_are_kept_as_ranges(self):
        self.assertEqual(extract.parse_peaks("[([-120.1, -120.9], 'm', None)]"), ([[-120.1, -120.9]], None))

    def test_unrecognized_shift_elements_become_null(self):
        self.assertEqual(
            extract.parse_peaks("[('-63.2', 's', None), (True, 's', None), ((1, 2), 's', None)]"),
            ([None, None, None], None),
        )
        self.assertEqual(extract.parse_peaks("[([-63.2, 'x'], 'm', None)]"), ([[-63.2, None]], None))

    def test_exactly_three_element_tuples_required(self):
        self.assertTrue(extract.is_peak_tuple((-63.2, "s", None)))
        for text in [
            "[(-63.2,)]",
            "[(-63.2, 's')]",
            "[(-63.2, 's', None, 'extra')]",
            "[()]",
            "[(-63.2, 's', None), (-63.3, 's')]",
        ]:
            with self.subTest(text=text):
                self.assertEqual(extract.parse_peaks(text), (None, "tuple-not-three-elements"))

    def test_list_items_must_be_tuples(self):
        self.assertEqual(extract.parse_peaks("[[-63.2, 's', None]]"), (None, "list-item-not-a-tuple"))
        self.assertEqual(extract.parse_peaks("[-63.2]"), (None, "list-item-not-a-tuple"))

    def test_empty_list(self):
        self.assertEqual(extract.parse_peaks("[]"), ([], None))

    def test_non_list_input(self):
        for text in ["(-63.2, 's', None)", "-63.2", "'text'", "{'a': 1}", "None"]:
            with self.subTest(text=text):
                self.assertEqual(extract.parse_peaks(text), (None, "not-a-list"))

    def test_list_to_range_mapping(self):
        self.assertEqual(extract.shift_element([-120.1, -120.9]), [-120.1, -120.9])
        self.assertEqual(extract.shift_element(-63), -63)
        self.assertIsNone(extract.shift_element(float("nan")))
        self.assertIsNone(extract.shift_element(float("inf")))
        self.assertIsNone(extract.shift_element(False))
        self.assertIsNone(extract.shift_element("x"))


if __name__ == "__main__":
    unittest.main()
