import { describe, expect, it, vi } from "vitest";

import { createCommandContext, createTestSeams } from "../../test/helpers/seams.ts";
import type { Prompter } from "../seams/prompter.ts";
import type { Question } from "./ask.ts";
import { askAsync } from "./ask.ts";

const WITH_DEFAULT: Question<boolean> = {
	ask: async (prompter) => prompter.confirm("Go?", false),
	unattended: { answer: true },
};

const WITHOUT_DEFAULT: Question<boolean> = {
	ask: async (prompter) => prompter.confirm("Go?", false),
	unattended: { hint: "Pass --yes.", text: "Go on?" },
};

describe(askAsync, () => {
	it("should ask at a terminal", async () => {
		expect.assertions(1);

		const prompter: Prompter = {
			choose: vi.fn<Prompter["choose"]>(),
			confirm: vi.fn<Prompter["confirm"]>().mockResolvedValue(false),
		};
		const context = createCommandContext({
			interactive: true,
			seams: createTestSeams({ prompter }),
		});

		await expect(askAsync(context, WITH_DEFAULT)).resolves.toBeFalse();
	});

	it("should take the default answer without a terminal", async () => {
		expect.assertions(1);

		// The default test prompter throws, so this also proves no prompt ran.
		const context = createCommandContext({ interactive: false });

		await expect(askAsync(context, WITH_DEFAULT)).resolves.toBeTrue();
	});

	it("should fail with needs_confirmation when there is no default answer", async () => {
		expect.assertions(1);

		const context = createCommandContext({ interactive: false });

		await expect(askAsync(context, WITHOUT_DEFAULT)).rejects.toMatchObject({
			code: "needs_confirmation",
			hint: "Pass --yes.",
			message: "Go on?",
		});
	});
});
