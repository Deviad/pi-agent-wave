import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Repository and package roots derived from this file's location, not from the launch
// directory. Several tests treat the whole checkout as their fixture: they copy `retry.ts`,
// read `tasks/*.md`, point a Python driver's `sys.path` at `scripts/`, or hand a root to
// `runProductionAudit` / `buildProductionReviewBundle`, whose internals rebuild package paths
// as `join(root, "extensions", "pi-agent-wave", …)` and therefore expect a REPOSITORY root.
//
// Those call sites previously used `process.cwd()` for the root, which only resolves while
// the suite is launched from the repository root. Launched from the package directory it
// produced doubled paths such as `extensions/pi-agent-wave/extensions/pi-agent-wave/index.ts`,
// so one file reported either 0 or 25 failures depending on where the command was typed.
// Deriving the roots keeps both launch directories equivalent, which also matches a published
// install: an installed package has no repository root around it at all.
//
// Depth is measured from this file's own directory (`test/support/`), so it is deliberately
// not the same count as the `new URL("../…")` anchors written in `test/*.test.ts`, which sit
// one level shallower. `resolve` is used instead of a bare URL string so neither root carries
// a trailing separator.
const here = fileURLToPath(new URL(".", import.meta.url));
export const packageRoot = resolve(here, "..", "..");
export const repoRoot = resolve(here, "..", "..", "..", "..");