import type { ChildProcess } from "node:child_process";

import type { Invocation } from "../process/command-line.ts";
import { readVariable } from "../process/environment.ts";
import type { ChildProcessBackend } from "../process/process-runner.ts";
import type { Environment } from "../seams/seams.ts";

/**
 * How long forge waits for the platform launcher to report. A launcher that
 * runs longer is left alone and counted as launched.
 */
export const LAUNCHER_WAIT_MS = 10_000;

/** One place to open in Roblox Studio. */
export interface StudioLaunch {
	cwd: string;
	env: Environment;
	/** The absolute path of the place file. */
	place: string;
}

/** Whether the platform launcher accepted the place. */
export type StudioLaunchOutcome = { message: string; type: "failed" } | { type: "launched" };

/**
 * Opens a place in Roblox Studio through the platform launcher, so Studio is
 * never a child of forge and never in a process group or job that forge
 * ends. The launcher is a one-shot helper: it hands the place to the OS and
 * exits. The plain child-process backend is {@link createStudioLauncher}; the
 * native addon can back this seam with job breakaway on Windows.
 */
export type StudioLauncher = (launch: StudioLaunch) => Promise<StudioLaunchOutcome>;

/** How the launcher ended, or that forge stopped waiting for it. */
type LauncherEnd =
	| { error: NodeJS.ErrnoException; type: "error" }
	| { exitCode: null | number; signal: NodeJS.Signals | null; type: "exit" }
	| { type: "waiting" };

/**
 * The platform launcher that opens a place with its registered app: `start`
 * in the Windows shell, `open` on macOS, `xdg-open` elsewhere. The Windows
 * place is quoted, and `start` gets an empty title first, so a path with
 * spaces is not read as the window title.
 *
 * @param place - The absolute path of the place file.
 * @param platform - The OS.
 * @param environment - Holds `ComSpec`, the Windows shell.
 * @returns The executable and arguments to spawn.
 */
export function studioLaunchInvocation(
	place: string,
	platform: NodeJS.Platform,
	environment: Environment,
): Invocation {
	if (platform === "win32") {
		return {
			args: ["/d", "/s", "/c", `"start "" "${place}""`],
			file: readVariable(environment, "ComSpec", "win32") ?? "cmd.exe",
			verbatimArguments: true,
		};
	}

	return { args: [place], file: platform === "darwin" ? "open" : "xdg-open" };
}

/**
 * The plain child-process backend of {@link StudioLauncher}. The launcher
 * starts detached (its own process group on Windows, its own session on
 * POSIX), hidden, and with no pipes; forge waits at most
 * {@link LAUNCHER_WAIT_MS} for it to exit and never keeps it alive.
 *
 * @param backend - The spawn seam, the clock for the wait, and the host.
 * @returns A {@link StudioLauncher}.
 */
export function createStudioLauncher(backend: ChildProcessBackend): StudioLauncher {
	return async (launch) => launchAsync(backend, launch);
}

async function waitForEndAsync(child: ChildProcess): Promise<LauncherEnd> {
	return new Promise((resolve) => {
		child.once("error", (error) => {
			resolve({ error, type: "error" });
		});
		child.once("exit", (exitCode, signal) => {
			resolve({ exitCode, signal, type: "exit" });
		});
	});
}

function describeFailure(file: string, end: LauncherEnd): string | undefined {
	if (end.type === "error") {
		return `Could not run ${file}: ${end.error.message}`;
	}

	if (end.type === "waiting" || end.exitCode === 0) {
		return undefined;
	}

	return end.exitCode === null
		? `${file} was ended by ${String(end.signal)}.`
		: `${file} exited with code ${end.exitCode}.`;
}

async function launchAsync(
	{ childProcess, clock, host }: ChildProcessBackend,
	{ cwd, env, place }: StudioLaunch,
): Promise<StudioLaunchOutcome> {
	const invocation = studioLaunchInvocation(place, host.platform, env);
	const { file } = invocation;
	const child = childProcess.spawn(file, [...invocation.args], {
		cwd,
		detached: true,
		env,
		stdio: "ignore",
		windowsHide: true,
		windowsVerbatimArguments: invocation.verbatimArguments === true,
	});

	const abort = new AbortController();
	// The race handles the timer's rejection once the launcher ends first.
	const waiting = clock
		.sleep(LAUNCHER_WAIT_MS, abort.signal)
		.then((): LauncherEnd => ({ type: "waiting" }));
	const end = await Promise.race([waitForEndAsync(child), waiting]);
	abort.abort();

	const message = describeFailure(file, end);
	if (message !== undefined) {
		return { message, type: "failed" };
	}

	child.unref();
	return { type: "launched" };
}
