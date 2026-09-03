#!/usr/bin/env python3
"""Optional Herdr presentation adapter for the shared Delegate Graph worker lifecycle."""

from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from delegate_core import *  # Re-export the historical test/operations surface during migration.

if __name__ == "__main__":
    main("herdr")
