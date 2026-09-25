import { Buffer } from "node:buffer";

import type { FlagDefinition } from "../cli/flags.ts";
import { ForgeError } from "../errors.ts";
import { logFilePath } from "../output/log-file.ts";
import type { CommandResult } from "../seams/reporter.ts";
import type { CommandContext, CommandInput } from "./context.ts";

/** Every log `forge logs` reads: `.forge/logs/<name>.log`. */
export const LOG_NAMES: ReadonlyArray<string> = [
	"compile",
	"compiler",
	"rojo",
	"start",
	"supervisor",
	"syncback",
];

export const LOGS_FLAGS: ReadonlyArray<FlagDefinition> = [
	{
		name: "follow",
		kind: "boolean",
		short: "f",
		text: "Keep printing lines as they are written, until Ctrl+C.",
	},
];

/** The end of a line a Windows tool wrote. */
const CARRIAGE_RETURN = /\r$/;

/** How often `--follow` reads the log again. */
export const FOLLOW_POLL_MS = 250;

/** Where a read of the log is. */
interface LogCursor {
	/** Bytes of the log already read. */
	offset: number;
	/** The end of a line that is not complete yet. */
	partial: string;
}

/**
 * `forge logs <name> [--follow]`: print a service's full log from
 * `.forge/logs` (spec #28: logs read files, not the session). With
 * `--follow`, keep printing new lines until Ctrl+C; a rotated log is read
 * again from its start. Each line is one `log` event.
 *
 * @param context - The run: project root, seams, and reporter.
 * @param input - The log's name and `--follow`.
 * @returns The log's path and how many lines were printed.
 * @rejects {ForgeError} `usage` when the name is missing or unknown.
 */
export async function runLogsAsync(
	context: CommandContext,
	input: CommandInput,
): Promise<CommandResult> {
	const service = input.argument;
	if (service === undefined) {
		throw usage("Name the log to read.");
	}

	if (!LOG_NAMES.includes(service)) {
		throw usage(`There is no log named "${service}".`);
	}

	const file = logFilePath(context.cwd, service);
	const cursor: LogCursor = { offset: 0, partial: "" };
	let lines = readNew(context, file, cursor, service);
	if (input.flags["follow"] === true) {
		lines += await followAsync(context, file, cursor, service);
	}

	return {
		data: { file, lines, service },
		summary: lines === 0 ? `${file} has no lines yet.` : `${lines} lines of ${file}.`,
	};
}

function usage(message: string): ForgeError {
	return new ForgeError("usage", message, {
		hint: `Name one of: ${LOG_NAMES.join(", ")}.`,
	});
}

/**
 * Report every whole line written since the cursor. A log that got smaller
 * was rotated: reading starts again at its start.
 *
 * @param context - The file system and reporter.
 * @param file - The log.
 * @param cursor - Where the last read ended; updated.
 * @param service - The log's name, for the events.
 * @returns How many lines were reported.
 */
function readNew(
	context: CommandContext,
	file: string,
	cursor: LogCursor,
	service: string,
): number {
	const { fileSystem } = context.seams;
	if (!fileSystem.existsSync(file)) {
		return 0;
	}

	const bytes = fileSystem.readFileSync(file);
	if (bytes.length < cursor.offset) {
		cursor.offset = 0;
		cursor.partial = "";
	}

	const text = cursor.partial + Buffer.from(bytes.subarray(cursor.offset)).toString("utf8");
	cursor.offset = bytes.length;
	const end = text.lastIndexOf("\n");
	cursor.partial = text.slice(end + 1);
	const lines = end === -1 ? [] : text.slice(0, end).split("\n");
	for (const line of lines) {
		context.reporter.emit({ line: line.replace(CARRIAGE_RETURN, ""), service, type: "log" });
	}

	return lines.length;
}

/**
 * Read the log again every {@link FOLLOW_POLL_MS} until a stop signal.
 *
 * @param context - The clock, signals, file system, and reporter.
 * @param file - The log.
 * @param cursor - Where the first read ended.
 * @param service - The log's name.
 * @returns How many lines were reported.
 */
async function followAsync(
	context: CommandContext,
	file: string,
	cursor: LogCursor,
	service: string,
): Promise<number> {
	const { clock, signals } = context.seams;
	const stop = new AbortController();
	const dispose = signals.onStop(() => {
		stop.abort();
	});
	let count = 0;
	try {
		for (;;) {
			await clock.sleep(FOLLOW_POLL_MS, stop.signal);
			count += readNew(context, file, cursor, service);
		}
	} catch {
		// The stop signal ended the wait.
		return count;
	} finally {
		dispose();
	}
}
