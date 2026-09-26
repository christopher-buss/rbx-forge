import type { FlagDefinition, FlagValues } from "../cli/flags.ts";
import { readCountFlag } from "../cli/flags.ts";
import { fetchStatusAsync, findSession } from "../client/session.ts";
import { ForgeError } from "../errors.ts";
import type { CommandResult } from "../seams/reporter.ts";
import { FRESH_BUILD_TIMEOUT_MS } from "../session/build-watch.ts";
import type { SessionStatus } from "../session/status.ts";
import { forgeFiles } from "../supervisor/session-files.ts";
import type { CommandContext, CommandInput } from "./context.ts";

export const STATUS_FLAGS: ReadonlyArray<FlagDefinition> = [
	{
		name: "wait",
		kind: "boolean",
		text: "Wait until the compiler's last build is fresh: no compile runs, and none started for a short quiet window. Run it after an edit.",
	},
	{
		name: "timeout",
		kind: "number",
		text: `How long --wait waits for a fresh build (default ${FRESH_BUILD_TIMEOUT_MS / 1000}). 0 does not wait: the status now.`,
		value: "<seconds>",
	},
];

const NO_INPUT: CommandInput = { config: {}, flags: {} };

/** The longest `--timeout`: a timer waits at most 2^31 - 1 ms. */
const MAX_WAIT_SECONDS = 2_147_000;

/**
 * `forge status`: the state of the project's running session: each service's
 * state, the Rojo port, the compiler's last build with its diagnostics, and
 * the last syncback run with its hooks. With `--wait`, the session answers
 * once the last build is fresh, so it reflects an edit made just before.
 *
 * @param context - The run: project root, seams, and reporter.
 * @param input - `--wait` and `--timeout`.
 * @returns The session's status as `data`, and one line per service as
 *   `summary`.
 * @rejects {ForgeError} `not_running` when no session runs;
 *   `supervisor_unresponsive` when its supervisor does not answer;
 *   `compile_timeout` when no fresh build comes in time; `service_failed`
 *   when the compiler stops during the wait; `usage` for a bad `--timeout`.
 */
export async function runStatusAsync(
	context: CommandContext,
	input: CommandInput = NO_INPUT,
): Promise<CommandResult> {
	const waitMs = waitOf(input.flags);
	const session = findSession(context.seams.fileSystem, forgeFiles(context.cwd));
	if (session === undefined) {
		throw new ForgeError("not_running", "No session runs for this project.", {
			hint: 'Start one with "forge up".',
		});
	}

	const status = await fetchStatusAsync(context.seams.ipc, session, waitMs);
	return { data: { ...status }, summary: describeStatus(status) };
}

/**
 * The wait `--wait` and `--timeout` ask for.
 *
 * @param flags - The parsed flags.
 * @returns Milliseconds (`--timeout` is in seconds, as for `down`; 0 does
 *   not wait), or `undefined` without `--wait`.
 * @throws {ForgeError} `usage` for `--timeout` without `--wait`, or a value
 *   that is not a number of seconds.
 */
function waitOf(flags: FlagValues): number | undefined {
	const value = flags["timeout"];
	if (flags["wait"] !== true) {
		if (value !== undefined) {
			throw new ForgeError("usage", "--timeout needs --wait.");
		}

		return undefined;
	}

	if (value === undefined) {
		return FRESH_BUILD_TIMEOUT_MS;
	}

	return readCountFlag("timeout", value, "seconds", MAX_WAIT_SECONDS) * 1000;
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The TTY lines of a status: the session, then one line per service.
 *
 * @param status - The session's status.
 * @returns The lines, without a final newline.
 */
function describeStatus({ phase, pid, services, sessionId }: SessionStatus): string {
	const { compiler, rojo, studio, syncback } = services;
	const build = compiler.lastBuild;
	const run = syncback.lastRun;
	const errors = plural(build?.errors ?? 0, "error");
	const building = compiler.building ? ", building" : "";
	const built = build === undefined ? "" : `, last build ${errors}`;
	const outcome = run?.ok === true ? "ok" : "failed";
	const synced = run === undefined ? "" : `, last run ${outcome}`;
	const port = rojo.port === null ? "" : ` on port ${rojo.port}`;
	const lines = [
		`Session ${sessionId} (pid ${pid}): ${phase}`,
		`  rojo: ${rojo.status}${port}`,
		`  compiler: ${compiler.status}${building}${built}`,
		`  syncback: ${syncback.status}${synced}`,
		`  studio: ${studio.status}`,
	];
	return lines.join("\n");
}
