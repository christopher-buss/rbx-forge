import { createInterface } from "node:readline/promises";

import { ForgeError } from "../errors.ts";

/**
 * Questions to a person at a terminal. Commands never call it directly; they
 * go through `cli/ask.ts`, which decides whether the run may prompt at all.
 * Both methods reject with `interrupted` when the input closes (Ctrl+C or
 * Ctrl+D) before an answer.
 */
export interface Prompter {
	/**
	 * Ask the user to pick one of `choices`. An empty answer picks `fallback`.
	 */
	choose: <T extends string>(
		question: string,
		choices: ReadonlyArray<T>,
		fallback: T,
	) => Promise<T>;
	/** Ask a yes/no question. An empty answer gives `fallback`. */
	confirm: (question: string, fallback: boolean) => Promise<boolean>;
}

interface Terminal {
	input: NodeJS.ReadableStream;
	output: NodeJS.WritableStream;
}

const YES = new Set(["y", "yes"]);
const NO = new Set(["n", "no"]);

/**
 * A prompter that reads answers line by line and writes each question before
 * it waits. A line that is not a valid answer asks the question again.
 *
 * @param input - Where answers come from (the process stdin).
 * @param output - Where questions go (the process stdout).
 * @returns A prompter bound to the two streams.
 */
export function createReadlinePrompter(
	input: NodeJS.ReadableStream,
	output: NodeJS.WritableStream,
): Prompter {
	const terminal = { input, output };

	return {
		choose: async (question, choices, fallback) => {
			return askUntilAsync(
				terminal,
				`${question} (${choices.join("/")}) [${fallback}] `,
				(answer) => {
					return answer === "" ? fallback : choices.find((choice) => choice === answer);
				},
			);
		},
		confirm: async (question, fallback) => {
			return askUntilAsync(
				terminal,
				`${question} (y/n) [${fallback ? "y" : "n"}] `,
				(answer) => (answer === "" ? fallback : readYesNo(answer)),
			);
		},
	};
}

function readYesNo(answer: string): boolean | undefined {
	if (YES.has(answer)) {
		return true;
	}

	return NO.has(answer) ? false : undefined;
}

async function askUntilAsync<T>(
	{ input, output }: Terminal,
	question: string,
	read: (answer: string) => T | undefined,
): Promise<T> {
	const lines = createInterface({ input, output });
	// The iterator buffers lines typed ahead of the next prompt.
	const typed = lines[Symbol.asyncIterator]();
	lines.setPrompt(question);

	try {
		for (;;) {
			lines.prompt();
			const line = await typed.next();
			if (line.done === true) {
				throw new ForgeError("interrupted", "The prompt was closed before an answer.");
			}

			const answer = read(line.value.trim().toLowerCase());
			if (answer !== undefined) {
				return answer;
			}
		}
	} finally {
		lines.close();
	}
}
