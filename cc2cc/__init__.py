"""CC2CC — Claude Code to Claude Code communication."""

# Single source of truth: the version declared in pyproject.toml (read from installed
# package metadata). Avoids drift between __init__.py and pyproject.toml.
from importlib.metadata import version as _version, PackageNotFoundError

try:
    __version__ = _version("cc2cc")
except PackageNotFoundError:  # running from a source tree without an editable install
    __version__ = "0.0.0+source"
