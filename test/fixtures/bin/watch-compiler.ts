/**
 * `rbxtsc -w` of `fake-worker.ts` with `FIXTURE_COMPILER_WATCH`: it
 * compiles the watched file once, then again on each change of it, and
 * prints what roblox-ts prints in watch mode (a colored time, `\r`, and an
 * empty line after each status line). Each compile reports one error per
 * line of the file that holds `error`.
 *
 * - `FIXTURE_COMPILE_DELAY_MS`: from a change to its start line (default 60).
 * - `FIXTURE_COMPILE_MS`: from a start line to its summary line (default 300).
 * - `FIXTURE_COMPILE_STARTS` and `FIXTURE_COMPILE_ENDS`: how many start lines
 *   and summary lines a change gives (default 1 each), such as 2 and 2 for a
 *   save during a compile, or 2 and 1 for two start lines of one compile.
 */
import { existsSync, readFileSync } from "node:fs";
import process from "node:process";

const CHANGE_POLL_MS = 20;

/**
 * Compile the watched file once, then again on each change.
 *
 * @param file - The path of the file the compiler watches.
 * @param environment - Holds the `FIXTURE_COMPILE_*` timing and counts.
 */
export function runWatchCompiler(file: string, environment: NodeJS.ProcessEnv): void {
	const delayMs = Number(environment["FIXTURE_COMPILE_DELAY_MS"] ?? "60");
	const compileMs = Number(environment["FIXTURE_COMPILE_MS"] ?? "300");
	const starts = Number(environment["FIXTURE_COMPILE_STARTS"] ?? "1");
	const ends = Number(environment["FIXTURE_COMPILE_ENDS"] ?? "1");
	process.stdout.write(statusLine("Starting compilation in watch mode..."));
	setTimeout(() => {
		compile(file);
	}, compileMs);
	let last = readWatched(file);
	setInterval(() => {
		const text = readWatched(file);
		if (text === last) {
			return;
		}

		last = text;
		setTimeout(() => {
			const start = "File change detected. Starting incremental compilation...";
			process.stdout.write(statusLine(start).repeat(starts));
			for (let end = 1; end <= ends; end += 1) {
				setTimeout(() => {
					compile(file);
				}, compileMs * end);
			}
		}, delayMs);
	}, CHANGE_POLL_MS);
}

/**
 * A watch-mode status line.
 *
 * @param text - What the line says after the time.
 * @returns The line, as roblox-ts prints it.
 */
function statusLine(text: string): string {
	const now = new Date();
	const time = now.toTimeString().slice(0, 8);
	return `[\u001B[90m${time}\u001B[0m] ${text}\r\n\r\n`;
}

function readWatched(file: string): string {
	return existsSync(file) ? readFileSync(file, "utf8") : "";
}

/**
 * Print one compile of the watched file: its errors, then the summary line.
 *
 * @param file - The path of the file the compiler watches.
 */
function compile(file: string): void {
	const count = readWatched(file)
		.split("\n")
		.filter((line) => line.includes("error")).length;
	const diagnostics = Array.from(
		{ length: count },
		(_, index) => `src/main.ts:${index + 1}:1 - error TS2322: Bad.\r\n\r\n`,
	);
	const noun = count === 1 ? "error" : "errors";
	const summary = statusLine(`Found ${count} ${noun}. Watching for file changes.`);
	process.stdout.write(`${diagnostics.join("")}${summary}`);
}
