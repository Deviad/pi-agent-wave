import { readFileSync } from "node:fs";

function stripComments(text) {
	let output = "";
	let state = "normal";
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		const next = text[index + 1];
		if (state === "string") {
			output += char;
			if (char === "\\") {
				if (next !== undefined) output += text[++index];
			} else if (char === '"') {
				state = "normal";
			}
			continue;
		}
		if (state === "line-comment") {
			if (char === "\n" || char === "\r") {
				output += char;
				state = "normal";
			} else {
				output += " ";
			}
			continue;
		}
		if (state === "block-comment") {
			if (char === "*" && next === "/") {
				output += "  ";
				index++;
				state = "normal";
			} else {
				output += char === "\n" || char === "\r" ? char : " ";
			}
			continue;
		}
		if (char === '"') {
			output += char;
			state = "string";
		} else if (char === "/" && next === "/") {
			output += "  ";
			index++;
			state = "line-comment";
		} else if (char === "/" && next === "*") {
			output += "  ";
			index++;
			state = "block-comment";
		} else {
			output += char;
		}
	}
	if (state === "block-comment") throw new SyntaxError("unterminated block comment");
	return output;
}

function stripTrailingCommas(text) {
	let output = "";
	let inString = false;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (inString) {
			output += char;
			if (char === "\\") {
				if (text[index + 1] !== undefined) output += text[++index];
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') {
			inString = true;
			output += char;
			continue;
		}
		if (char === ",") {
			let lookahead = index + 1;
			while (/\s/.test(text[lookahead] ?? "")) lookahead++;
			if (text[lookahead] === "]" || text[lookahead] === "}") {
				output += " ";
				continue;
			}
		}
		output += char;
	}
	return output;
}

export function parseJsonc(text, source = "JSONC input") {
	try {
		return JSON.parse(stripTrailingCommas(stripComments(String(text))));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new SyntaxError(`${source}: ${message}`, { cause: error });
	}
}

export function readJsonc(path) {
	return parseJsonc(readFileSync(path, "utf8"), path);
}
