"""Configure pytest: ensure cc2cc package is importable in subprocess scripts."""

import os
from pathlib import Path

# Add repo root to PYTHONPATH so scripts invoked as subprocesses can import cc2cc
REPO_ROOT = str(Path(__file__).resolve().parent)
existing = os.environ.get("PYTHONPATH", "")
os.environ["PYTHONPATH"] = REPO_ROOT + (os.pathsep + existing if existing else "")
