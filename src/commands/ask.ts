import { ForgeError } from "../errors.ts";
import type { Prompter } from "../seams/prompter.ts";
import type { CommandContext } from "./context.ts";

/**
 * A question a command may ask.
 *
 * @template T - The type of the answer.
 */
export interface Question<T> {
	/** Ask it at a terminal. */
	ask: (prompter: Prompter) => Promise<T>;
	/**
	 * How to answer without asking, such as a flag. For `needs_confirmation`.
	 */
	hint: string;
	/** The question, for `needs_confirmation`. */
	text: string;
	/**
	 * The answer when the run cannot prompt. `undefined` means there is no
	 * safe default, so the command fails with `needs_confirmation`.
	 */
	unattended: T | undefined;
}

/**
 * Ask a question, or answer it without a prompt when the run is not
 * interactive. Non-interactive runs never prompt.
 *
 * @template T - The type of the answer.
 * @param context - The run; decides whether it may prompt.
 * @param question - What to ask, and how to answer without asking.
 * @returns The answer.
 * @rejects {ForgeError} `needs_confirmation` when the run cannot prompt and
 *   the question has no unattended answer.
 */
export async function askAsync<T>(context: CommandContext, question: Question<T>): Promise<T> {
	if (context.interactive) {
		return question.ask(context.seams.prompter);
	}

	if (question.unattended === undefined) {
		throw new ForgeError("needs_confirmation", question.text, { hint: question.hint });
	}

	return question.unattended;
}
