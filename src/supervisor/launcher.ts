import type { ChildProcessByStdio } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { ForgeError } from "../errors.ts";
import { keepTail } from "../process/stream-tail.ts";
import type { ChildProcessRunner } from "../seams/child-process.ts";
import type { Host } from "../seams/host.ts";
import type { CommandResult, ReporterEvent } from "../seams/reporter.ts";
import type { Environment } from "../seams/seams.ts";
import type { SessionRequest, SupervisorMessage } from "./channel.ts";
import { encodeSessionRequest, encodeStop, failureError, parseMessage } from "./channel.ts";

/** A supervisor that `forge start` launched. */
export interface SupervisorRun {
	/**
	 * Resolves with the session's result once the supervisor has exited.
	 *
	 * @rejects {ForgeError} The session's failure, or `internal_error` when
	 *   the supervisor did not start or exited without a result.
	 */
	result: Promise<CommandResult>;
	/** Pass a stop signal on to the supervisor through the owner pipe. */
	stop: (signal: NodeJS.Signals) => void;
}

/** What one launch varies by. */
export interface SupervisorLaunch {
	/** The project root: the supervisor's working directory. */
	cwd: string;
	/** The supervisor's environment. */
	env: Environment;
	/** Gets each progress event the supervisor reports. */
	onEvent: (event: ReporterEvent) => void;
	request: SessionRequest;
}

/**
 * Starts a supervisor process for `forge start`, bound to the caller by the
 * owner pipe.
 */
export type SupervisorLauncher = (launch: SupervisorLaunch) => SupervisorRun;

/** What the launcher spawns with. */
export interface SupervisorBackend {
	childProcess: ChildProcessRunner;
	host: Pick<Host, "execPath" | "platform">;
}

type SupervisorProcess = ChildProcessByStdio<Writable, Readable, Readable>;

/** The result line, once the supervisor wrote it. */
type ResultMessage = Extract<SupervisorMessage, { type: "result" }>;

/**
 * Make the launcher: it runs `entry` (the built `supervisor.mjs`) with the
 * current Node executable. The supervisor's stdin is the owner pipe: this
 * process holds its only write end, so when this process dies, however it
 * dies, the supervisor reads EOF and stops the session. The pipe exists
 * from the supervisor's creation, so no moment exists in which a session
 * runs without its owner.
 *
 * On POSIX the supervisor runs in its own session, so a terminal's signals
 * reach only `start`, which passes them on. On Windows it shares the console.
 *
 * @param backend - The spawn seam and host.
 * @param entry - Path of the supervisor entry script.
 * @returns Starts one supervisor per call.
 */
export function createSupervisorLauncher(
	backend: SupervisorBackend,
	entry: string,
): SupervisorLauncher {
	return ({ cwd, env, onEvent, request }) => {
		const child: SupervisorProcess = backend.childProcess.spawn(
			backend.host.execPath,
			[entry, encodeSessionRequest(request)],
			{
				cwd,
				detached: backend.host.platform !== "win32",
				env,
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			},
		);
		child.stdin.on("error", ignore);
		return {
			result: watchAsync(child, onEvent),
			stop: (signal) => {
				child.stdin.write(encodeStop(signal));
			},
		};
	};
}

function ignore(): void {
	// A write after the supervisor exited; its exit reports the outcome.
}

/**
 * The error for a supervisor that exited without a result: it crashed.
 *
 * @param code - Its exit code.
 * @param signal - The signal that ended it.
 * @param stderr - The end of its stderr.
 * @returns An `internal_error` that names how it ended.
 */
function crashed(code: null | number, signal: NodeJS.Signals | null, stderr: string): ForgeError {
	const how = signal === null ? `exit code ${String(code)}` : `signal ${signal}`;
	const tail = stderr === "" ? "" : `\n${stderr}`;
	return new ForgeError(
		"internal_error",
		`The supervisor exited (${how}) without a result.${tail}`,
		{
			hint: "This is a bug in forge. Please report it.",
		},
	);
}

/**
 * Relay the supervisor's events, then settle with its result once it has
 * exited.
 *
 * @param child - The supervisor process.
 * @param onEvent - Gets each event.
 * @returns The session's result.
 */
async function watchAsync(
	child: SupervisorProcess,
	onEvent: (event: ReporterEvent) => void,
): Promise<CommandResult> {
	const stderr = keepTail(child.stderr);
	let result: ResultMessage | undefined;
	createInterface({ input: child.stdout }).on("line", (line) => {
		const message = parseMessage(line);
		if (message?.type === "event") {
			onEvent(message.event);
		} else if (message !== undefined) {
			result = message;
		}
	});

	return new Promise((resolve, reject) => {
		child.once("error", (err) => {
			reject(
				new ForgeError("internal_error", `The supervisor did not start: ${err.message}`),
			);
		});
		child.once("close", (code, signal) => {
			if (result === undefined) {
				reject(crashed(code, signal, stderr()));
			} else if (result.ok) {
				resolve({ data: result.data, summary: result.summary });
			} else {
				reject(failureError(result.error));
			}
		});
	});
}
