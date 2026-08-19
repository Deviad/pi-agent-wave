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
