"""Tests for the ecosystem-check example modules.

Run directly::

    python3 ecosystem-check/test_modules.py

or through unittest discovery::

    python3 -m unittest discover -s ecosystem-check -p 'test_*.py'
"""

import importlib.util
import pathlib
import unittest

MODULE_DIR = pathlib.Path(__file__).resolve().parent


def _load(module_name: str):
    """Load a sibling module by file path.

    The directory name contains a hyphen, so it is not an importable package;
    the modules are loaded from their file paths instead.
    """
    path = MODULE_DIR / f"{module_name}.py"
    spec = importlib.util.spec_from_file_location(f"ecosystem_check_{module_name}", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


a = _load("a")
b = _load("b")
c = _load("c")


class AlphaTests(unittest.TestCase):
    """Checks for ``alpha`` (factorial)."""

    def test_factorial_values(self):
        self.assertEqual(a.alpha(0), 1)
        self.assertEqual(a.alpha(1), 1)
        self.assertEqual(a.alpha(5), 120)
        self.assertEqual(a.alpha(10), 3628800)

    def test_negative_raises_value_error(self):
        with self.assertRaises(ValueError):
            a.alpha(-1)

    def test_non_int_raises_type_error(self):
        for value in ("5", 5.0, True, None):
            with self.subTest(value=value):
                with self.assertRaises(TypeError):
                    a.alpha(value)


class BetaTests(unittest.TestCase):
    """Checks for ``beta`` (Fibonacci sequence)."""

    def test_sequence_values(self):
        self.assertEqual(b.beta(0), [])
        self.assertEqual(b.beta(1), [0])
        self.assertEqual(b.beta(2), [0, 1])
        self.assertEqual(b.beta(7), [0, 1, 1, 2, 3, 5, 8])

    def test_negative_raises_value_error(self):
        with self.assertRaises(ValueError):
            b.beta(-1)

    def test_non_int_raises_type_error(self):
        for value in ("7", 7.0, True, None):
            with self.subTest(value=value):
                with self.assertRaises(TypeError):
                    b.beta(value)


class GammaTests(unittest.TestCase):
    """Checks for ``gamma`` (primality test)."""

    def test_prime_values(self):
        for value in (2, 3, 5, 7, 11, 97):
            with self.subTest(value=value):
                self.assertIs(c.gamma(value), True)

    def test_composite_and_small_values(self):
        for value in (0, 1, 4, 9, 100):
            with self.subTest(value=value):
                self.assertIs(c.gamma(value), False)

    def test_non_int_raises_type_error(self):
        for value in ("7", 7.0, True, None):
            with self.subTest(value=value):
                with self.assertRaises(TypeError):
                    c.gamma(value)


if __name__ == "__main__":
    unittest.main()
