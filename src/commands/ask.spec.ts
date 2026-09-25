import { describe, expect, it, vi } from "vitest";

import { createCommandContext, createTestSeams } from "../../test/helpers/seams.ts";
import type { Prompter } from "../seams/prompter.ts";
import type { Question } from "./ask.ts";
import { askAsync } from "./ask.ts";

const QUESTION: Question<boolean> = {
	ask: async (prompter) => prompter.confirm("Go?", false),
	hint: "Pass --yes.",
	text: "Go on?",
	unattended: undefined,
};

function question(unattended: Question<boolean>["unattended"]): Question<boolean> {
	return { ...QUESTION, unattended };
}

describe(askAsync, () => {
	it("should ask at a terminal", async () => {
		expect.assertions(1);

		const prompter: Prompter = {
			choose: vi.fn<Prompter["choose"]>(),
			confirm: vi.fn<Prompter["confirm"]>().mockResolvedValue(true),
		};
		const context = createCommandContext({
			interactive: true,
			seams: createTestSeams({ prompter }),
		});

		await expect(askAsync(context, question(false))).resolves.toBeTrue();
	});

	it("should take the unattended answer without a terminal", async () => {
		expect.assertions(1);

		// The default test prompter throws, so this also proves no prompt ran.
		const context = createCommandContext({ interactive: false });

		await expect(askAsync(context, question(true))).resolves.toBeTrue();
	});

	it("should fail with needs_confirmation when there is no unattended answer", async () => {
		expect.assertions(1);

		const context = createCommandContext({ interactive: false });

		await expect(askAsync(context, QUESTION)).rejects.toMatchObject({
			code: "needs_confirmation",
			hint: "Pass --yes.",
			message: "Go on?",
		});
	});
});
