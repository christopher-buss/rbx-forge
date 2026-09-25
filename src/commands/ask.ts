import { ForgeError } from "../errors.ts";
import type { Prompter } from "../seams/prompter.ts";
import type { CommandContext } from "./context.ts";

/**
 * How a question is answered when the run cannot prompt: with a safe default,
 * or by failing with `needs_confirmation`.
 *
 * @template T - The type of the answer.
 */
export type Unattended<T> =
	| {
			/** How to answer without asking, such as a flag. */
			hint: string;
			/** The question, as the error message. */
			text: string;
	  }
	| {
			/** The answer to take. */
			answer: T;
	  };

/**
 * A question a command may ask.
 *
 * @template T - The type of the answer.
 */
export interface Question<T> {
	/** Ask it at a terminal. */
	ask: (prompter: Prompter) => Promise<T>;
	/** What happens when the run cannot prompt. */
	unattended: Unattended<T>;
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
 *   the question has no safe default.
 */
export async function askAsync<T>(
	context: CommandContext,
	{ ask, unattended }: Question<T>,
): Promise<T> {
	if (context.interactive) {
		return ask(context.seams.prompter);
	}

	if ("answer" in unattended) {
		return unattended.answer;
	}

	throw new ForgeError("needs_confirmation", unattended.text, { hint: unattended.hint });
}
