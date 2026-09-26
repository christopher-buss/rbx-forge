import type { ChildProcess } from "node:child_process";

import { toForgeError } from "../errors.ts";
import type { NativeLoader } from "../native/addon.ts";
import type { Invocation } from "../process/command-line.ts";
import { readVariable, withVariables } from "../process/environment.ts";
import type { ChildProcessBackend } from "../process/process-runner.ts";
import type { FileSystem } from "../seams/file-system.ts";
import type { Environment } from "../seams/seams.ts";
import type { StudioExecutable } from "./discover.ts";
import { findStudioExecutable } from "./discover.ts";

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
	/** The `--studio-path` flag: the Studio executable to start. */
	studioPath?: string | undefined;
}

/** A Studio forge started itself, pinned at the start. */
export interface StudioProcess {
	pid: number;
	/** Its OS start time (see `processStartTime`). */
	startTime: string;
}

/**
 * Whether Studio got the place. `studio`: the Studio forge started
 * directly; absent when the platform launcher opened the place. `hint`:
 * what the user can do, when forge knows better than the default.
 */
export type StudioLaunchOutcome =
	| { hint?: string | undefined; message: string; type: "failed" }
	| { studio?: StudioProcess; type: "launched" };

/**
 * Opens a place in Roblox Studio, so Studio is never a child of forge and
 * never in a process group or job that forge ends. With a Studio executable
 * found ({@link findStudioExecutable}), forge starts it directly with the
 * place as its only argument; else the platform launcher opens the place.
 */
export type StudioLauncher = (launch: StudioLaunch) => Promise<StudioLaunchOutcome>;

/** What the launcher starts processes with. */
export interface StudioLaunchBackend extends ChildProcessBackend {
	fileSystem: Pick<FileSystem, "statSync">;
	native: NativeLoader;
}

/** How the launcher ended, or that forge stopped waiting for it. */
type LauncherEnd =
	| { error: NodeJS.ErrnoException; type: "error" }
	| { exitCode: null | number; signal: NodeJS.Signals | null; type: "exit" }
	| { type: "waiting" };

/**
 * The Windows shell reads the place from this variable: cmd.exe expands
 * `%NAME%` in a command line even inside quotes, but never expands the
 * text a variable expanded to.
 */
export const PLACE_VARIABLE = "RBX_FORGE_PLACE";

/** The launcher to spawn, with the environment it runs with. */
export interface StudioLaunchInvocation extends Invocation {
	env: Environment;
}

/**
 * The platform launcher that opens a place with its registered app: `start`
 * in the Windows shell, `open` on macOS, `xdg-open` elsewhere. On Windows the
 * place goes through {@link PLACE_VARIABLE}, so a `%` in its path is never
 * expanded; it is quoted, and `start` gets an empty title first, so a path
 * with spaces is not read as the window title.
 *
 * @param place - The absolute path of the place file.
 * @param platform - The OS.
 * @param environment - The launcher's environment; holds `ComSpec`, the
 *   Windows shell.
 * @returns The executable, arguments, and environment to spawn.
 */
export function studioLaunchInvocation(
	place: string,
	platform: NodeJS.Platform,
	environment: Environment,
): StudioLaunchInvocation {
	if (platform === "win32") {
		return {
			args: ["/d", "/s", "/c", `"start "" "%${PLACE_VARIABLE}%""`],
			env: withVariables(environment, { [PLACE_VARIABLE]: place }, "win32"),
			file: readVariable(environment, "ComSpec", "win32") ?? "cmd.exe",
			verbatimArguments: true,
		};
	}

	return { args: [place], env: environment, file: platform === "darwin" ? "open" : "xdg-open" };
}

/**
 * The {@link StudioLauncher} of forge.
 *
 * - Direct: Studio starts with the place as its only argument, as the
 *   registered open command does. Windows: through the addon, out of this
 *   process's job, with no console and no inherited handles; a job that
 *   forbids breakaway falls back to the platform launcher. POSIX: detached
 *   in its own session, with no pipes. The process is pinned at once, so
 *   later checks rely on its PID and start time.
 * - Platform launcher: detached, hidden, and with no pipes; forge waits at
 *   most {@link LAUNCHER_WAIT_MS} for it to exit and never keeps it alive.
 *
 * @param backend - The spawn seam, clock, host, file system, and addon.
 * @returns A {@link StudioLauncher}.
 */
export function createStudioLauncher(backend: StudioLaunchBackend): StudioLauncher {
	return async (launch) => {
		let executable: StudioExecutable | undefined;
		try {
			executable = findStudioExecutable(backend, launch);
		} catch (err) {
			const { hint, message } = toForgeError(err);
			return { hint, message, type: "failed" };
		}

		return executable === undefined
			? launchThroughPlatformAsync(backend, launch)
			: launchDirectAsync(backend, launch, executable.path);
	};
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

async function launchThroughPlatformAsync(
	{ childProcess, clock, host }: ChildProcessBackend,
	{ cwd, env, place }: StudioLaunch,
): Promise<StudioLaunchOutcome> {
	const invocation = studioLaunchInvocation(place, host.platform, env);
	const { file } = invocation;
	const child = childProcess.spawn(file, [...invocation.args], {
		cwd,
		detached: true,
		env: invocation.env,
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

function definedOnly(environment: Environment): Record<string, string> {
	const defined: Record<string, string> = {};
	for (const [name, value] of Object.entries(environment)) {
		if (value !== undefined) {
			defined[name] = value;
		}
	}

	return defined;
}

/**
 * Windows: start Studio through the addon, out of this process's job.
 *
 * @param backend - The addon.
 * @param launch - The place, directory, and environment.
 * @param executable - The Studio executable.
 * @returns Its PID; `undefined` when the job forbids breakaway.
 */
function startBreakingAway(
	backend: Pick<StudioLaunchBackend, "native">,
	{ cwd, env, place }: StudioLaunch,
	executable: string,
): number | undefined {
	const { spawnDetached } = backend.native();
	return (
		spawnDetached?.({ args: [place], cwd, env: definedOnly(env), program: executable }) ??
		undefined
	);
}

async function waitForErrorAsync(child: ChildProcess): Promise<NodeJS.ErrnoException> {
	return new Promise((resolve) => {
		child.once("error", resolve);
	});
}

/**
 * POSIX: start Studio in its own session, with no pipes.
 *
 * @param backend - The spawn seam.
 * @param launch - The place, directory, and environment.
 * @param executable - The Studio executable.
 * @returns Its PID, or why it did not start.
 */
async function startInSessionAsync(
	backend: Pick<StudioLaunchBackend, "childProcess">,
	{ cwd, env, place }: StudioLaunch,
	executable: string,
): Promise<number | string> {
	const child = backend.childProcess.spawn(executable, [place], {
		cwd,
		detached: true,
		env,
		stdio: "ignore",
		windowsHide: true,
	});
	if (child.pid === undefined) {
		const error = await waitForErrorAsync(child);
		return `Could not run ${executable}: ${error.message}`;
	}

	child.unref();
	return child.pid;
}

/**
 * Start Studio itself.
 *
 * @param backend - The spawn seam, host, and addon.
 * @param launch - The place, directory, and environment.
 * @param executable - The Studio executable.
 * @returns The pinned Studio; the platform launcher's outcome when the
 *   Windows job forbids breakaway.
 */
async function launchDirectAsync(
	backend: StudioLaunchBackend,
	launch: StudioLaunch,
	executable: string,
): Promise<StudioLaunchOutcome> {
	const started =
		backend.host.platform === "win32"
			? startBreakingAway(backend, launch, executable)
			: await startInSessionAsync(backend, launch, executable);
	if (started === undefined) {
		return launchThroughPlatformAsync(backend, launch);
	}

	if (typeof started === "string") {
		return { message: started, type: "failed" };
	}

	const pid = started;
	const pinned = backend.native().pinProcess(pid);
	if (pinned === null) {
		return { message: `${executable} (PID ${pid}) exited at once.`, type: "failed" };
	}

	return { studio: { pid, startTime: pinned.startTime }, type: "launched" };
}
