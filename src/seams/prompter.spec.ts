import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import type { Prompter } from "./prompter.ts";
import { createReadlinePrompter } from "./prompter.ts";

interface Terminal {
	/** Send lines of input, one per string. */
	answer: (...lines: Array<string>) => void;
	/** End the input, as Ctrl+D does. */
	close: () => void;
	input: PassThrough;
	/** Everything the prompter wrote. */
	output: () => string;
	prompter: Prompter;
}

function makeTerminal(): Terminal {
	const input = new PassThrough();
	const output = new PassThrough();
	let written = "";
	output.setEncoding("utf8");
	output.on("data", (chunk: string) => {
		written += chunk;
	});

	return {
		answer: (...lines) => {
			setImmediate(() => {
				input.write(lines.map((line) => `${line}\n`).join(""));
			});
		},
		close: () => {
			setImmediate(() => {
				input.end();
			});
		},
		input,
		output: () => written,
		prompter: createReadlinePrompter(input, output),
	};
}

describe(createReadlinePrompter, () => {
	it("should show the question with its choices and default", async () => {
		expect.assertions(1);

		const terminal = makeTerminal();
		const answer = terminal.prompter.choose("Project type?", ["rbxts", "luau"], "rbxts");
		terminal.answer("luau");
		await answer;

		expect(terminal.output()).toBe("Project type? (rbxts/luau) [rbxts] ");
	});

	it("should return the chosen value, ignoring case and spaces", async () => {
		expect.assertions(1);

		const terminal = makeTerminal();
		const answer = terminal.prompter.choose("Type?", ["rbxts", "luau"], "rbxts");
		terminal.answer("  LUAU ");

		await expect(answer).resolves.toBe("luau");
	});

	it("should return the fallback choice for an empty answer", async () => {
		expect.assertions(1);

		const terminal = makeTerminal();
		const answer = terminal.prompter.choose("Type?", ["rbxts", "luau"], "luau");
		terminal.answer("");

		await expect(answer).resolves.toBe("luau");
	});

	it("should ask again after an answer that is not a choice", async () => {
		expect.assertions(2);

		const terminal = makeTerminal();
		const answer = terminal.prompter.choose("Type?", ["rbxts", "luau"], "rbxts");
		terminal.answer("python", "luau");

		await expect(answer).resolves.toBe("luau");
		expect(terminal.output()).toBe("Type? (rbxts/luau) [rbxts] ".repeat(2));
	});

	it.for([
		["y", true],
		["YES", true],
		["n", false],
		["no", false],
	] as const)("should read %s as %s", async ([line, expected]) => {
		expect.assertions(1);

		const terminal = makeTerminal();
		const answer = terminal.prompter.confirm("Replace?", !expected);
		terminal.answer(line);

		await expect(answer).resolves.toBe(expected);
	});

	it.for([
		[true, "Replace? (y/n) [y] "],
		[false, "Replace? (y/n) [n] "],
	] as const)("should show the yes/no default %s", async ([fallback, shown]) => {
		expect.assertions(1);

		const terminal = makeTerminal();
		const answer = terminal.prompter.confirm("Replace?", fallback);
		terminal.answer("");
		await answer;

		expect(terminal.output()).toBe(shown);
	});

	it("should let go of the input after an answer", async () => {
		expect.assertions(1);

		const terminal = makeTerminal();
		const answer = terminal.prompter.confirm("Replace?", false);
		terminal.answer("y");
		await answer;

		expect(terminal.input.listenerCount("data")).toBe(0);
	});

	it.for([true, false])("should return the fallback %s for an empty answer", async (fallback) => {
		expect.assertions(1);

		const terminal = makeTerminal();
		const answer = terminal.prompter.confirm("Replace?", fallback);
		terminal.answer("");

		await expect(answer).resolves.toBe(fallback);
	});

	it("should ask again after an answer that is not yes or no", async () => {
		expect.assertions(1);

		const terminal = makeTerminal();
		const answer = terminal.prompter.confirm("Replace?", false);
		terminal.answer("maybe", "y");

		await expect(answer).resolves.toBeTrue();
	});

	it("should fail as interrupted when the input closes", async () => {
		expect.assertions(1);

		const terminal = makeTerminal();
		const answer = terminal.prompter.confirm("Replace?", false);
		terminal.close();

		await expect(answer).rejects.toMatchObject({
			code: "interrupted",
			message: "The prompt was closed before an answer.",
		});
	});
});
