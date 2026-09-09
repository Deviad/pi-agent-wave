"""Print how delegate_core normalizes owned paths before the TypeScript audit sees them.

Containment in lib/agentfs-sandbox.ts depends on owned paths arriving absolute: it
resolves each entry against the process working directory and then makes it relative to
the sandbox base. delegate_core.parsed_owned_paths() is what guarantees that, by
absolutizing relative entries against the attempt workspace. This driver exercises that
guarantee directly so the dependency is pinned instead of assumed.
"""
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import delegate_core as core

attempt = Path(sys.argv[1]).resolve()
raw = json.dumps(["agent-output/result.json", str(attempt / "absolute.txt"), "../escape/outside.txt", "nested/../inside.txt"])
print(json.dumps({"attempt": str(attempt), "normalized": core.parsed_owned_paths(raw, attempt)}))