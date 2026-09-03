import { describe, expect, test } from "./test-api.mjs";
import questionnaireExtension from "../questionnaire.ts";

const input = { right: "\x1b[C", left: "\x1b[D", down: "\x1b[B", space: " ", enter: "\r", escape: "\x1b" };
const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text };

function registeredTool(): any {
	let tool: any;
	questionnaireExtension({ registerTool(value: any) { tool = value; } } as never);
	return tool;
}

async function executeWithInputs(questions: any[], drive: (component: any) => void) {
	const tool = registeredTool();
	const ctx = {
		mode: "tui",
		ui: {
			custom(factory: any) {
				let result: any;
				const component = factory({ requestRender() {} }, theme, {}, (value: any) => { result = value; });
				drive(component);
				if (result === undefined) throw new Error("questionnaire did not finish");
				return result;
			},
		},
	};
	return tool.execute("test-call", { questions }, undefined, undefined, ctx);
}

const questions = [
	{ id: "scope", label: "Scope", prompt: "Choose a scope", options: [{ value: "small", label: "Small" }, { value: "large", label: "Large" }], allowOther: false },
	{ id: "priority", label: "Priority", prompt: "Choose priority", options: [{ value: "normal", label: "Normal" }, { value: "urgent", label: "Urgent" }], allowOther: false },
];

describe("questionnaire companion", () => {
	test("registers the structured questionnaire tool", () => {
		const tool = registeredTool();
		expect(tool.name).toBe("questionnaire");
		expect(tool.description).toContain("one tab per question");
	});

	test("returns structured awaiting-user state to ACP/RPC clients without opening terminal UI", async () => {
		const tool = registeredTool();
		let opened = false;
		const result = await tool.execute("air", { questions: [questions[0]] }, undefined, undefined, { mode: "rpc", hasUI: false, ui: { custom() { opened = true; } } });
		expect(opened).toBeFalse();
		expect(result.details).toMatchObject({ status: "awaiting_user" });
		expect(result.details.questions[0]).toMatchObject({ id: "scope", label: "Scope", allowOther: false });
		expect(result.details.questions[0].options).toHaveLength(2);
	});

	test("renders single-question choices as a numbered table without letter prefixes", async () => {
		const tool = registeredTool();
		const result = await tool.execute("air", { questions: [questions[0]] }, undefined, undefined, { mode: "rpc", hasUI: false, ui: { custom() {} } });
		const text = result.content[0].text;
		expect(text).toContain("Awaiting your input");
		expect(text).toContain("Choose a scope");
		expect(text).toContain("| # | Choice | Description |");
		expect(text).toContain("| 1 | Small |");
		expect(text).toContain("| 2 | Large |");
		expect(text).toContain("Reply with the number of your choice");
		expect(text).not.toContain("· Scope");
		expect(text).not.toContain('"status":"awaiting_user"');
		expect(text.startsWith("{")).toBeFalse();
	});

	test("renders multi-question choices as numbered tables with letter prefixes", async () => {
		const tool = registeredTool();
		const result = await tool.execute("air", { questions }, undefined, undefined, { mode: "rpc", hasUI: false, ui: { custom() {} } });
		const text = result.content[0].text;
		expect(text).toContain("answer the 2 questions");
		expect(text).toContain("A · Scope");
		expect(text).toContain("B · Priority");
		expect(text).toContain("| 1 | Small |");
		expect(text).toContain("| 2 | Urgent |");
		expect(text).toContain("A2, B1");
		expect(text).not.toContain('"status":"awaiting_user"');
		expect(text.startsWith("{")).toBeFalse();
	});

	function pickerCtx(selectImpl: (title: string, options: string[]) => Promise<string | undefined>): any {
		return { mode: "rpc", hasUI: true, ui: { select: selectImpl, custom() {} } };
	}

	const BACK = "\u2190 Back";
	const CANCEL = "\u2715 Cancel questionnaire";
	const SUBMIT = "\u2713 Submit answers";

	test("collects a single answer and only sends it after Submit", async () => {
		const tool = registeredTool();
		const calls: { title: string; options: string[] }[] = [];
		const picks = ["Large", SUBMIT];
		let i = 0;
		const result = await tool.execute("air", { questions: [questions[0]] }, undefined, undefined, pickerCtx(async (title, options) => {
			calls.push({ title, options: [...options] });
			return picks[i++];
		}));
		expect(calls).toHaveLength(2);
		expect(calls[0].title).toBe("Choose a scope");
		expect(calls[0].options).toEqual(["Small", "Large", CANCEL]);
		expect(calls[1].options).toEqual([SUBMIT, BACK, CANCEL]);
		expect(calls[1].title).toContain("scope: large");
		expect(result.details.cancelled).toBeFalse();
		expect(result.details.answers).toEqual([{ id: "scope", value: "large", label: "Large", wasCustom: false, index: 1 }]);
		expect(result.content[0].text).toContain("scope: large");
	});

	test("collects multiple answers sequentially and confirms via Submit", async () => {
		const tool = registeredTool();
		const calls: { title: string; options: string[] }[] = [];
		const picks = ["Small", "Urgent", SUBMIT];
		let i = 0;
		const result = await tool.execute("air", { questions }, undefined, undefined, pickerCtx(async (title, options) => {
			calls.push({ title, options: [...options] });
			return picks[i++];
		}));
		expect(result.details.cancelled).toBeFalse();
		expect(result.details.answers.map((a: any) => a.value)).toEqual(["small", "urgent"]);
		expect(calls[0].options).toEqual(["Small", "Large", CANCEL]);
		expect(calls[1].options).toEqual(["Normal", "Urgent", BACK, CANCEL]);
		expect(calls[2].options).toEqual([SUBMIT, BACK, CANCEL]);
	});

	test("Back revisits the previous question and rewrites its answer before Submit", async () => {
		const tool = registeredTool();
		const picks = ["Small", BACK, "Large", "Urgent", SUBMIT];
		let i = 0;
		const result = await tool.execute("air", { questions }, undefined, undefined, pickerCtx(async () => picks[i++]));
		expect(result.details.cancelled).toBeFalse();
		expect(result.details.answers.map((a: any) => a.value)).toEqual(["large", "urgent"]);
		expect(i).toBe(5);
	});

	test("Back from the Submit review lets an answer be changed", async () => {
		const tool = registeredTool();
		const picks = ["Small", "Urgent", BACK, "Normal", SUBMIT];
		let i = 0;
		const result = await tool.execute("air", { questions }, undefined, undefined, pickerCtx(async () => picks[i++]));
		expect(result.details.cancelled).toBeFalse();
		expect(result.details.answers.map((a: any) => a.value)).toEqual(["small", "normal"]);
	});

	test("selecting the Cancel option aborts with partial answers", async () => {
		const tool = registeredTool();
		const picks = ["Small", CANCEL];
		let i = 0;
		const result = await tool.execute("air", { questions }, undefined, undefined, pickerCtx(async () => picks[i++]));
		expect(result.details.cancelled).toBeTrue();
		expect(result.details.answers.map((a: any) => a.value)).toEqual(["small"]);
		expect(result.content[0].text).toContain("cancelled");
	});

	test("cancelling at the Submit review aborts with the answers not sent", async () => {
		const tool = registeredTool();
		const picks = ["Small", "Urgent", CANCEL];
		let i = 0;
		const result = await tool.execute("air", { questions }, undefined, undefined, pickerCtx(async () => picks[i++]));
		expect(result.details.cancelled).toBeTrue();
		expect(result.details.answers.map((a: any) => a.value)).toEqual(["small", "urgent"]);
		expect(result.content[0].text).toContain("cancelled");
	});

	test("dismissing the picker aborts with no answers", async () => {
		const tool = registeredTool();
		const result = await tool.execute("air", { questions }, undefined, undefined, pickerCtx(async () => undefined));
		expect(result.details.cancelled).toBeTrue();
		expect(result.details.answers).toEqual([]);
		expect(result.content[0].text).toContain("cancelled");
	});

	test("collects multi-tab selections and submits once", async () => {
		const result = await executeWithInputs(questions, (component) => {
			component.handleInput(input.down);
			component.handleInput(input.space);
			component.handleInput(input.down);
			component.handleInput(input.space);
			expect(component.render(100).join("\n")).toContain("Ready to submit");
			component.handleInput(input.enter);
		});
		expect(result.details.cancelled).toBeFalse();
		expect(result.details.answers.map((answer: any) => answer.value)).toEqual(["large", "urgent"]);
	});

	test("Escape cancels without answers", async () => {
		const result = await executeWithInputs([questions[0]], (component) => component.handleInput(input.escape));
		expect(result.details).toMatchObject({ cancelled: true, answers: [] });
	});
});
