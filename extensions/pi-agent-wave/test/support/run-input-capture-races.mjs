import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { captureRunInputs } from "../../lib/run-inputs.ts";

const root = process.argv[2];
const source = join(root, "source");
const originalRead = fs.readSync;
for (const mutation of ["replace", "grow", "shrink", "rewrite"]) {
	fs.writeFileSync(source, "initial bytes");
	let changed = false;
	fs.readSync = (...args) => {
		if (!changed) {
			changed = true;
			if (mutation === "replace") {
				fs.writeFileSync(join(root, "replacement"), "replacement"); fs.renameSync(join(root, "replacement"), source);
			} else if (mutation === "grow") fs.appendFileSync(source, "more");
			else if (mutation === "shrink") fs.truncateSync(source, 0);
			else fs.writeFileSync(source, "changed bytes");
		}
		return originalRead(...args);
	};
	syncBuiltinESMExports();
	assert.throws(() => captureRunInputs([{ name: "archive", path: source }]), /source changed during capture/);
	fs.readSync = originalRead; syncBuiltinESMExports();
}
console.log("bounded descriptor capture refuses observed replacement, growth, shrinkage and mutation");
