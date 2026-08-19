export interface FailureClassification {
	kind: "transient" | "permanent";
	reason: string;
}

export interface ModelFallbackDecision extends FailureClassification {
	advance: boolean;
	attempt: number;
	model: string;
	fallbackReason: string | null;
}

const TRANSIENT_PATTERNS: Array<[RegExp, string]> = [
	[/\b429\b/i, "http-429"],
	[/\b500\b/i, "http-500"],
	[/\b502\b/i, "http-502"],
	[/\b503\b/i, "http-503"],
	[/\b504\b/i, "http-504"],
	[/rate[ -]?limit/i, "rate-limit"],
	[/\bquota\b/i, "quota"],
	[/overload(?:ed)?/i, "overloaded"],
	[/ETIMEDOUT|timed? out/i, "timeout"],
	[/ECONNRESET|connection reset/i, "connection-reset"],
	[/connection[- ]closed/i, "connection-closed"],
];

/** Classifies infrastructure-shaped failures without treating semantic verdicts as retryable. */
export function classifyFailure(message: string, semanticVerdict = false): FailureClassification {
	if (semanticVerdict) return { kind: "permanent", reason: "semantic-verdict" };
	for (const [pattern, reason] of TRANSIENT_PATTERNS) {
		if (pattern.test(message)) return { kind: "transient", reason };
	}
	return { kind: "permanent", reason: "unclassified" };
}

/** Selects the next frozen route entry only for transient launch/provider failures. */
export function selectModelFallback(
	chain: readonly string[],
	attempt: number,
	message: string,
	options: { exactLock?: boolean; semanticVerdict?: boolean } = {},
): ModelFallbackDecision {
	if (chain.length === 0) throw new Error("frozen model chain must not be empty");
	if (!Number.isInteger(attempt) || attempt < 0 || attempt >= chain.length) {
		throw new Error("model attempt is outside the frozen chain");
	}
	const classification = classifyFailure(message, options.semanticVerdict);
	const advance = !options.exactLock && classification.kind === "transient" && attempt + 1 < chain.length;
	const selectedAttempt = advance ? attempt + 1 : attempt;
	return {
		...classification,
		advance,
		attempt: selectedAttempt,
		model: chain[selectedAttempt]!,
		fallbackReason: advance ? classification.reason : null,
	};
}

/** Returns full-jitter exponential backoff for zero-based retry attempt. */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
	if (!Number.isInteger(attempt) || attempt < 0) throw new Error("attempt must be a non-negative integer");
	const ceiling = Math.min(300_000, 30_000 * 2 ** attempt);
	const sample = random();
	if (sample < 0 || sample > 1) throw new Error("random source must return a value between 0 and 1");
	return Math.floor(sample * ceiling);
}
