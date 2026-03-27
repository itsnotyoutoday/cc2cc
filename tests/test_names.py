"""Tests for name generation concepts (Python-side validation)."""
import re
import pytest

NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,30}$")

class TestNameValidation:
    def test_valid_names(self):
        for name in ["brave-fox", "alpha", "agent-01", "a", "test-agent-99"]:
            assert NAME_RE.match(name), f"{name} should be valid"

    def test_invalid_names(self):
        for name in ["", "-starts", "Has-Upper", "has spaces", "a" * 32]:
            assert not NAME_RE.match(name), f"{name} should be invalid"
