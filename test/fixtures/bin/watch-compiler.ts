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
 * - `FIXTURE_COMPILER_NDJSON=1`: print what `sloptor build -w --json` prints
 *   instead: one JSON event per line (`watching`, `buildStart`, and
 *   `buildEnd` with the diagnostics), with `\r\n` line ends.
 */
import { existsSync, readFileSync } from "node:fs";
import process from "node:process";

const CHANGE_POLL_MS = 20;

/** How one compiler prints its watch-mode output. */
interface WatchOutput {
	/** The end of a compile with an error on each of these lines. */
	end: (lines: ReadonlyArray<number>) => string;
	/** The start of a compile; rbxtsc prints this text. */
	start: (text: string) => string;
	/** What it prints once, before the first compile. */
	watching: string;
}

/**
 * Compile the watched file once, then again on each change. With no watched
 * file, print one roblox-ts summary line, in either output mode.
 *
 * @param environment - Holds `FIXTURE_COMPILER_WATCH` (the path of the file
 *   the compiler watches), the `FIXTURE_COMPILE_*` timing and counts, and
 *   `FIXTURE_COMPILER_NDJSON`.
 */
export function runWatchCompiler(environment: NodeJS.ProcessEnv): void {
	const file = environment["FIXTURE_COMPILER_WATCH"];
	if (file === undefined) {
		process.stdout.write("Found 0 errors. Watching for file changes.\n");
		return;
	}

	compileOnChange(file, environment);
}

function readWatched(file: string): string {
	return existsSync(file) ? readFileSync(file, "utf8") : "";
}

/**
 * The lines of the watched file that hold `error`: each is one error of a
 * compile.
 *
 * @param file - The path of the file the compiler watches.
 * @returns The 1-based line numbers.
 */
function errorLines(file: string): Array<number> {
	return readWatched(file)
		.split("\n")
		.flatMap((line, index) => (line.includes("error") ? [index + 1] : []));
}

/**
 * Compile the watched file once, then again on each change.
 *
 * @param file - The path of the file the compiler watches.
 * @param environment - Holds the `FIXTURE_COMPILE_*` timing and counts, and
 *   `FIXTURE_COMPILER_NDJSON`.
 */
function compileOnChange(file: string, environment: NodeJS.ProcessEnv): void {
	const delayMs = Number(environment["FIXTURE_COMPILE_DELAY_MS"] ?? "60");
	const compileMs = Number(environment["FIXTURE_COMPILE_MS"] ?? "300");
	const starts = Number(environment["FIXTURE_COMPILE_STARTS"] ?? "1");
	const ends = Number(environment["FIXTURE_COMPILE_ENDS"] ?? "1");
	const output = environment["FIXTURE_COMPILER_NDJSON"] === "1" ? NDJSON : RBXTSC;
	process.stdout.write(output.watching + output.start("Starting compilation in watch mode..."));
	setTimeout(() => {
		process.stdout.write(output.end(errorLines(file)));
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
			process.stdout.write(output.start(start).repeat(starts));
			for (let end = 1; end <= ends; end += 1) {
				setTimeout(() => {
					process.stdout.write(output.end(errorLines(file)));
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

/** What roblox-ts prints: each error, then the summary line. */
const RBXTSC: WatchOutput = {
	end: (lines) => {
		const diagnostics = lines.map(
			(line) => `src/main.ts:${line}:1 - error TS2322: Bad.\r\n\r\n`,
		);
		const noun = lines.length === 1 ? "error" : "errors";
		const summary = statusLine(`Found ${lines.length} ${noun}. Watching for file changes.`);
		return `${diagnostics.join("")}${summary}`;
	},
	start: statusLine,
	watching: "",
};

function toIsoNow(): string {
	const now = new Date();
	return now.toISOString();
}

function ndjsonLine(event: Record<string, unknown>): string {
	return `${JSON.stringify({ at: toIsoNow(), ...event })}\r\n`;
}

/** What sloptor prints with `--json`: one event per line. */
const NDJSON: WatchOutput = {
	end: (lines) => {
		return ndjsonLine({
			diagnostics: lines.map((line) => {
				return {
					code: "TS2322",
					col: 1,
					file: "src/main.ts",
					line,
					message: "Bad.",
					severity: "error",
				};
			}),
			durationMs: 1,
			event: "buildEnd",
			files: 1,
			ok: lines.length === 0,
		});
	},
	start: () => ndjsonLine({ changed: [], event: "buildStart" }),
	watching: ndjsonLine({ event: "watching", files: 1 }),
};
