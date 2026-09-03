/**
 * Questionnaire Tool - Unified tool for asking single or multiple questions
 *
 * Single question: simple options list
 * Multiple questions: tab bar navigation between questions
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { requireRuntime } from "./require-runtime.ts";

// Types
interface QuestionOption {
	value: string;
	label: string;
	description?: string;
}

type RenderOption = QuestionOption & { isOther?: boolean };

interface Question {
	id: string;
	label: string;
	prompt: string;
	options: QuestionOption[];
	allowOther: boolean;
}

interface Answer {
	id: string;
	value: string;
	label: string;
	wasCustom: boolean;
	index?: number;
}

interface QuestionnaireResult {
	questions: Question[];
	answers: Answer[];
	cancelled: boolean;
}

// Schema
const QuestionOptionSchema = Type.Object({
	value: Type.String({ description: "The value returned when selected" }),
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this question" }),
	label: Type.Optional(
		Type.String({
			description: "Short contextual label for tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2)",
		}),
	),
	prompt: Type.String({ description: "The full question text to display" }),
	options: Type.Array(QuestionOptionSchema, { description: "Available options to choose from" }),
	allowOther: Type.Optional(Type.Boolean({ description: "Allow 'Type something' option (default: true)" })),
});

const QuestionnaireParams = Type.Object({
	questions: Type.Array(QuestionSchema, { description: "Questions to ask the user" }),
});

function errorResult(
	message: string,
	questions: Question[] = [],
): { content: { type: "text"; text: string }[]; details: QuestionnaireResult } {
	return {
		content: [{ type: "text", text: message }],
		details: { questions, answers: [], cancelled: true },
	};
}

// Human-readable rendering of the awaiting-user state for non-TUI clients (ACP/RPC,
// e.g. IntelliJ via pi-acp). Only content[].text reaches those clients, so we must
// not dump raw JSON there; the structured state stays in the result details.
// Choices render as a Markdown table numbered so the user can reply with a number
// (or letter+number when several questions are asked at once).
function mdCell(text: string): string {
	return text.replace(/\|/g, "\\|");
}

function letterFor(index: number): string {
	return String.fromCharCode(65 + (index % 26));
}

function renderQuestionBlock(q: Question, prefix: string): string {
	const title = prefix ? `**${prefix} · ${q.label}** — ${q.prompt}` : `**${q.label}** — ${q.prompt}`;
	const rows = ["| # | Choice | Description |", "|---|--------|-------------|"];
	q.options.forEach((option, i) => {
		rows.push(`| ${i + 1} | ${mdCell(option.label)} | ${mdCell(option.description ?? "")} |`);
	});
	if (q.allowOther) rows.push(`| ${q.options.length + 1} | Other | Type your own answer |`);
	return `${title}\n\n${rows.join("\n")}`;
}

function renderAwaitingUser(questions: Question[]): string {
	const multi = questions.length > 1;
	const heading = multi
		? `Awaiting your input — answer the ${questions.length} questions below, then the task resumes.`
		: "Awaiting your input — answer the question below, then the task resumes.";
	const instruction = multi
		? "Reply with one number per question, prefixed by its letter — e.g. `A2, B1` — or type your own answer."
		: "Reply with the number of your choice, or type your own answer.";
	const blocks: string[] = [heading, instruction];
	questions.forEach((q, i) => blocks.push(renderQuestionBlock(q, multi ? letterFor(i) : "")));
	return blocks.join("\n\n");
}

// Native ACP picker: present clickable options through ctx.ui.select, which pi-acp
// renders as a requestPermission dialog, block until the user picks, and hand the
// answers straight back to the model. Prefer this over returning the questions as
// text, which non-TUI clients show only as a collapsed tool result that the model
// then narrates over. Free-form "other" input is unavailable in ACP (input dialogs
// are cancelled), so a custom answer must be typed in chat instead. A click in the
// dialog is otherwise final, so each picker appends explicit Back / Cancel options,
// and the answers are only sent back after an explicit Submit confirmation.
const ACP_BACK_LABEL = "\u2190 Back";
const ACP_CANCEL_LABEL = "\u2715 Cancel questionnaire";
const ACP_SUBMIT_LABEL = "\u2713 Submit answers";

async function runAcpPicker(
	questions: Question[],
	ctx: ExtensionContext,
): Promise<{ content: { type: "text"; text: string }[]; details: QuestionnaireResult }> {
	const answers: (Answer | undefined)[] = new Array(questions.length).fill(undefined);
	const answered = (): Answer[] => answers.filter((a): a is Answer => a !== undefined);
	const cancelled = (): { content: { type: "text"; text: string }[]; details: QuestionnaireResult } => ({
		content: [{ type: "text", text: "Questionnaire cancelled." }],
		details: { questions, answers: answered(), cancelled: true },
	});
	let i = 0;
	for (;;) {
		while (i < questions.length) {
			const q = questions[i];
			const labels = q.options.map((o) => o.label);
			const choices = [...labels];
			if (i > 0) choices.push(ACP_BACK_LABEL);
			choices.push(ACP_CANCEL_LABEL);
			const picked = await ctx.ui.select(q.prompt || q.label, choices);
			if (picked === undefined || picked === ACP_CANCEL_LABEL) return cancelled();
			if (picked === ACP_BACK_LABEL) {
				i--;
				continue;
			}
			const index = labels.indexOf(picked);
			const option = index >= 0 ? q.options[index] : undefined;
			answers[i] = { id: q.id, value: option?.value ?? picked, label: picked, wasCustom: false, index };
			i++;
		}
		// Every question answered: require an explicit Submit before the answers are sent back.
		const confirm = await ctx.ui.select(`Review your answers:\n\n${renderAnswerLines(answered())}`, [
			ACP_SUBMIT_LABEL,
			ACP_BACK_LABEL,
			ACP_CANCEL_LABEL,
		]);
		if (confirm === ACP_SUBMIT_LABEL) {
			return {
				content: [{ type: "text", text: renderAnswerSummary(answered()) }],
				details: { questions, answers: answered(), cancelled: false },
			};
		}
		if (confirm === undefined || confirm === ACP_CANCEL_LABEL) return cancelled();
		// Back from the review: return to the last question so answers can be changed.
		i = Math.max(0, questions.length - 1);
	}
}

function renderAnswerLines(answers: Answer[]): string {
	return answers.map((a) => `- ${a.id}: ${a.value} (${a.label})`).join("\n");
}

function renderAnswerSummary(answers: Answer[]): string {
	if (answers.length === 0) return "Questionnaire completed with no answers.";
	return `User answered:\n${renderAnswerLines(answers)}`;
}

export default function questionnaire(pi: ExtensionAPI) {
	requireRuntime();
	pi.registerTool({
		name: "questionnaire",
		label: "Questionnaire",
		description:
			"Ask the user one or more questions in a structured terminal UI. Use this tool instead of printing numbered prose questions whenever predefined answers are available. For single questions, show a simple option list. For multiple questions, show one tab per question.",
		parameters: QuestionnaireParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.questions.length === 0) {
				return errorResult("Error: No questions provided");
			}

			// Normalize questions with defaults
			const questions: Question[] = params.questions.map((q, i) => ({
				...q,
				label: q.label || `Q${i + 1}`,
				allowOther: q.allowOther !== false,
			}));
			if (ctx.mode !== "tui") {
				if (ctx.hasUI) {
					return runAcpPicker(questions, ctx);
				}
				const awaiting = { status: "awaiting_user" as const, questions };
				return { content: [{ type: "text" as const, text: renderAwaitingUser(questions) }], details: awaiting };
			}

			const isMulti = questions.length > 1;
			const totalTabs = questions.length + 1; // questions + Submit

			const result = await ctx.ui.custom<QuestionnaireResult>((tui, theme, _kb, done) => {
				// State
				let currentTab = 0;
				let optionIndex = 0;
				let inputMode = false;
				let inputQuestionId: string | null = null;
				let cachedLines: string[] | undefined;
				const answers = new Map<string, Answer>();

				// Editor for "Type something" option
				const editorTheme: EditorTheme = {
					borderColor: (s) => theme.fg("accent", s),
					selectList: {
						selectedPrefix: (t) => theme.fg("accent", t),
						selectedText: (t) => theme.fg("accent", t),
						description: (t) => theme.fg("muted", t),
						scrollInfo: (t) => theme.fg("dim", t),
						noMatch: (t) => theme.fg("warning", t),
					},
				};
				const editor = new Editor(tui, editorTheme);

				// Helpers
				function refresh() {
					cachedLines = undefined;
					tui.requestRender();
				}

				function submit(cancelled: boolean) {
					done({ questions, answers: Array.from(answers.values()), cancelled });
				}

				function currentQuestion(): Question | undefined {
					return questions[currentTab];
				}

				function currentOptions(): RenderOption[] {
					const q = currentQuestion();
					if (!q) return [];
					const opts: RenderOption[] = [...q.options];
					if (q.allowOther) {
						opts.push({ value: "__other__", label: "Type something.", isOther: true });
					}
					return opts;
				}

				function allAnswered(): boolean {
					return questions.every((q) => answers.has(q.id));
				}

				function advanceAfterAnswer() {
					if (!isMulti) {
						submit(false);
						return;
					}
					if (currentTab < questions.length - 1) {
						currentTab++;
					} else {
						currentTab = questions.length; // Submit tab
					}
					optionIndex = 0;
					refresh();
				}

				function saveAnswer(questionId: string, value: string, label: string, wasCustom: boolean, index?: number) {
					answers.set(questionId, { id: questionId, value, label, wasCustom, index });
				}

				// Editor submit callback
				editor.onSubmit = (value) => {
					if (!inputQuestionId) return;
					const trimmed = value.trim() || "(no response)";
					saveAnswer(inputQuestionId, trimmed, trimmed, true);
					inputMode = false;
					inputQuestionId = null;
					editor.setText("");
					advanceAfterAnswer();
				};

				function handleInput(data: string) {
					// Input mode: route to editor
					if (inputMode) {
						if (matchesKey(data, Key.escape)) {
							inputMode = false;
							inputQuestionId = null;
							editor.setText("");
							refresh();
							return;
						}
						editor.handleInput(data);
						refresh();
						return;
					}

					const q = currentQuestion();
					const opts = currentOptions();

					// Tab navigation (multi-question only)
					if (isMulti) {
						if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
							currentTab = (currentTab + 1) % totalTabs;
							optionIndex = 0;
							refresh();
							return;
						}
						if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
							currentTab = (currentTab - 1 + totalTabs) % totalTabs;
							optionIndex = 0;
							refresh();
							return;
						}
					}

					// Submit tab
					if (currentTab === questions.length) {
						if (matchesKey(data, Key.enter) && allAnswered()) {
							submit(false);
						} else if (matchesKey(data, Key.escape)) {
							submit(true);
						}
						return;
					}

					// Option navigation
					if (matchesKey(data, Key.up)) {
						optionIndex = Math.max(0, optionIndex - 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.down)) {
						optionIndex = Math.min(opts.length - 1, optionIndex + 1);
						refresh();
						return;
					}

					// Space selects the highlighted answer; Enter is reserved for submission.
					if (matchesKey(data, Key.space) && q) {
						const opt = opts[optionIndex];
						if (opt.isOther) {
							inputMode = true;
							inputQuestionId = q.id;
							editor.setText("");
							refresh();
							return;
						}
						saveAnswer(q.id, opt.value, opt.label, false, optionIndex + 1);
						advanceAfterAnswer();
						return;
					}

					// Cancel
					if (matchesKey(data, Key.escape)) {
						submit(true);
					}
				}

				function render(width: number): string[] {
					if (cachedLines) return cachedLines;

					const lines: string[] = [];
					const renderWidth = Math.max(1, width);
					const q = currentQuestion();
					const opts = currentOptions();

					function addWrapped(text: string) {
						lines.push(...wrapTextWithAnsi(text, renderWidth));
					}

					function addWrappedWithPrefix(prefix: string, text: string) {
						const prefixWidth = visibleWidth(prefix);
						if (prefixWidth >= renderWidth) {
							addWrapped(prefix + text);
							return;
						}
						const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
						const continuationPrefix = " ".repeat(prefixWidth);
						for (let i = 0; i < wrapped.length; i++) {
							lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
						}
					}

					lines.push(theme.fg("accent", "─".repeat(renderWidth)));

					// Tab bar (multi-question only)
					if (isMulti) {
						const tabs: string[] = ["← "];
						for (let i = 0; i < questions.length; i++) {
							const isActive = i === currentTab;
							const isAnswered = answers.has(questions[i].id);
							const lbl = questions[i].label;
							const box = isAnswered ? "■" : "□";
							const color = isAnswered ? "success" : "muted";
							const text = ` ${box} ${lbl} `;
							const styled = isActive ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(color, text);
							tabs.push(`${styled} `);
						}
						const canSubmit = allAnswered();
						const isSubmitTab = currentTab === questions.length;
						const submitText = " ✓ Submit ";
						const submitStyled = isSubmitTab
							? theme.bg("selectedBg", theme.fg("text", submitText))
							: theme.fg(canSubmit ? "success" : "dim", submitText);
						tabs.push(`${submitStyled} →`);
						addWrappedWithPrefix(" ", tabs.join(""));
						lines.push("");
					}

					// Helper to render options list
					function renderOptions() {
						for (let i = 0; i < opts.length; i++) {
							const opt = opts[i];
							const selected = i === optionIndex;
							const isOther = opt.isOther === true;
							const prefix = selected ? theme.fg("accent", "> ") : "  ";
							const label = `${i + 1}. ${opt.label}${isOther && inputMode ? " ✎" : ""}`;
							const color = selected || (isOther && inputMode) ? "accent" : "text";

							addWrappedWithPrefix(prefix, theme.fg(color, label));
							if (opt.description) {
								addWrappedWithPrefix("     ", theme.fg("muted", opt.description));
							}
						}
					}

					// Content
					if (inputMode && q) {
						addWrappedWithPrefix(" ", theme.fg("text", q.prompt));
						lines.push("");
						// Show options for reference
						renderOptions();
						lines.push("");
						addWrappedWithPrefix(" ", theme.fg("muted", "Your answer:"));
						for (const line of editor.render(Math.max(1, renderWidth - 2))) {
							lines.push(` ${line}`);
						}
						lines.push("");
						addWrappedWithPrefix(" ", theme.fg("dim", "Enter to submit • Esc to cancel"));
					} else if (currentTab === questions.length) {
						addWrappedWithPrefix(" ", theme.fg("accent", theme.bold("Ready to submit")));
						lines.push("");
						for (const question of questions) {
							const answer = answers.get(question.id);
							if (answer) {
								const prefix = answer.wasCustom ? "(wrote) " : "";
								const summary = `${theme.fg("muted", `${question.label}: `)}${theme.fg("text", prefix + answer.label)}`;
								addWrappedWithPrefix(" ", summary);
							}
						}
						lines.push("");
						if (allAnswered()) {
							addWrappedWithPrefix(" ", theme.fg("success", "Press Enter to submit"));
						} else {
							const missing = questions
								.filter((q) => !answers.has(q.id))
								.map((q) => q.label)
								.join(", ");
							addWrappedWithPrefix(" ", theme.fg("warning", `Unanswered: ${missing}`));
						}
					} else if (q) {
						addWrappedWithPrefix(" ", theme.fg("text", q.prompt));
						lines.push("");
						renderOptions();
					}

					lines.push("");
					if (!inputMode) {
						const help = isMulti
							? "Tab/←→ questions • ↑↓ answers • Space select • Enter submit • Esc cancel"
							: "↑↓ navigate • Space select • Esc cancel";
						addWrappedWithPrefix(" ", theme.fg("dim", help));
					}
					lines.push(theme.fg("accent", "─".repeat(renderWidth)));

					cachedLines = lines;
					return lines;
				}

				return {
					render,
					invalidate: () => {
						cachedLines = undefined;
					},
					handleInput,
				};
			});

			if (result.cancelled) {
				return {
					content: [{ type: "text", text: "User cancelled the questionnaire" }],
					details: result,
				};
			}

			const answerLines = result.answers.map((a) => {
				const qLabel = questions.find((q) => q.id === a.id)?.label || a.id;
				if (a.wasCustom) {
					return `${qLabel}: user wrote: ${a.label}`;
				}
				return `${qLabel}: user selected: ${a.index}. ${a.label}`;
			});

			return {
				content: [{ type: "text", text: answerLines.join("\n") }],
				details: result,
			};
		},

		renderCall(args, theme, _context) {
			const qs = (args.questions as Question[]) || [];
			const count = qs.length;
			const labels = qs.map((q) => q.label || q.id).join(", ");
			let text = theme.fg("toolTitle", theme.bold("questionnaire "));
			text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
			if (labels) {
				text += theme.fg("dim", ` (${labels})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as QuestionnaireResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			const lines = details.answers.map((a) => {
				if (a.wasCustom) {
					return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${theme.fg("muted", "(wrote) ")}${a.label}`;
				}
				const display = a.index ? `${a.index}. ${a.label}` : a.label;
				return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${display}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
