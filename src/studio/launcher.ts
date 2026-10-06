import type { ChildProcess } from "node:child_process";

import type { StudioDesktop } from "../config/schema.ts";
import { toForgeError } from "../errors.ts";
import type { NativeLoader, PinnedProcess } from "../native/addon.ts";
import type { Invocation } from "../process/command-line.ts";
import { readVariable, withVariables } from "../process/environment.ts";
import type { ChildProcessBackend } from "../process/process-runner.ts";
import type { FileSystem } from "../seams/file-system.ts";
import type { Environment } from "../seams/seams.ts";
import type { InstalledStudio, StudioExecutable } from "./discover.ts";
import { findStudioExecutable } from "./discover.ts";
import { createSnapshotLightingLauncher } from "./snapshot-lighting-launcher.ts";
import type { SnapshotLightingLauncher } from "./snapshot-lighting-launcher.ts";

/**
 * How long forge waits for the platform launcher to report. A launcher that
 * runs longer is left alone and counted as launched.
 */
export const LAUNCHER_WAIT_MS = 10_000;

/** One place to open in Roblox Studio. */
export interface StudioLaunch {
	/**
	 * Prepare a session plugin after discovery, immediately before direct
	 * launch.
	 */
	beforeLaunch?: (() => Promise<void>) | undefined;
	cwd: string;
	desktop?: StudioDesktop | undefined;
	env: Environment;
	/** The absolute path of the place file. */
	place: string;
	/** A session marker script, run after Studio opens the place. */
	runScript?: string | undefined;
	/** The `--studio-path` flag: the Studio executable to start. */
	studioPath?: string | undefined;
	/** Start a detached watcher for a snapshot's delayed migration prompt. */
	watchHiddenLighting?: boolean | undefined;
}

/** A Studio forge started itself, pinned at the start. */
export interface StudioProcess {
	desktop?: StudioDesktop;
	pid: number;
	/** Its OS start time (see `processStartTime`). */
	startTime: string;
}

/** A verified Studio process with its actual desktop. */
export type LocatedStudio = StudioProcess & { desktop: StudioDesktop };

/**
 * Whether Studio got the place. `studio`: the Studio forge started
 * directly; absent when the platform launcher opened the place. `hint`:
 * what the user can do, when forge knows better than the default.
 */
export type StudioLaunchOutcome =
	| { desktop?: StudioDesktop; studio?: StudioProcess; type: "launched"; warning?: string }
	| { hint?: string | undefined; message: string; studio?: never; type: "failed" };

/**
 * Opens a place in Roblox Studio, so Studio is never a child of forge and
 * never in a process group or job that forge ends. With a Studio executable
 * found ({@link findStudioExecutable}), forge starts it directly with the
 * place, optionally using RunScript; else the platform launcher opens the
 * place. Rejects with `native_missing` when Windows has no addon.
 */
export type StudioLauncher = (launch: StudioLaunch) => Promise<StudioLaunchOutcome>;

/** What the launcher starts processes with. */
export interface StudioLaunchBackend extends ChildProcessBackend {
	fileSystem: Pick<FileSystem, "statSync">;
	installedStudio: InstalledStudio;
	native: NativeLoader;
}

/** How the launcher ended, or that forge stopped waiting for it. */
type LauncherEnd =
	| { error: NodeJS.ErrnoException; type: "error" }
	| { exitCode: null | number; signal: NodeJS.Signals | null; type: "exit" }
	| { type: "waiting" };

/**
 * Read a verified Studio's identity and desktop from its pin.
 *
 * @param pinned - A process verified as Studio.
 * @returns Its process identity and desktop.
 */
export function studioProcess(pinned: PinnedProcess): LocatedStudio {
	return { desktop: pinned.desktop(), pid: pinned.pid, startTime: pinned.startTime };
}

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
 * - Direct: Studio starts with the place, or a session's RunScript task.
 *   Windows: through the addon, out of this process's job, with no console and
 *   only its streams and desktop inherited; a job that forbids breakaway falls
 *   back to the platform launcher. POSIX: detached in its own session, with no
 *   pipes. The process is pinned at once, so later checks rely on its PID and
 *   start time.
 * - Platform launcher: detached, hidden, and with no pipes; forge waits at
 *   most {@link LAUNCHER_WAIT_MS} for it to exit and never keeps it alive.
 *
 * @param backend - The spawn seam, clock, host, file system, and addon.
 * @param supervisorEntry - The entry for a detached snapshot Lighting watcher.
 * @returns A {@link StudioLauncher}.
 */
export function createStudioLauncher(
	backend: StudioLaunchBackend,
	supervisorEntry: string,
): StudioLauncher {
	const watch = createSnapshotLightingLauncher(backend, supervisorEntry);
	return async (launch) => {
		const outcome = await launchStudioAsync(backend, launch);
		return watchSnapshotLighting(watch, launch, outcome);
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

/**
 * The actual desktop after the platform launcher opens Studio.
 *
 * @param desktop - The requested desktop, when specified.
 * @param platform - The host platform.
 * @returns A launch result, including any hidden-desktop fallback warning.
 */
function platformLaunchOutcome(
	desktop: StudioDesktop | undefined,
	platform: NodeJS.Platform,
): StudioLaunchOutcome {
	return {
		type: "launched",
		...(desktop === undefined ? {} : { desktop: "user" }),
		...(desktop === "hidden" && platform === "win32"
			? {
					warning:
						"Studio opened on the user's desktop: the platform launcher cannot use the hidden desktop.",
				}
			: {}),
	};
}

async function launchThroughPlatformAsync(
	{ childProcess, clock, host }: ChildProcessBackend,
	{ cwd, desktop, env, place }: StudioLaunch,
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
	return platformLaunchOutcome(desktop, host.platform);
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

function studioArguments({ place, runScript }: StudioLaunch): Array<string> {
	return runScript === undefined
		? [place]
		: ["--task", "RunScript", "--localPlaceFile", place, "--runScriptFile", runScript];
}

/**
 * Windows: start Studio through the addon, out of this process's job.
 *
 * @param backend - The addon.
 * @param launch - The place, directory, and environment.
 * @param executable - The Studio executable.
 * @returns Its PID; `undefined` when breakaway or hidden desktop setup is unavailable.
 */
function startBreakingAway(
	backend: Pick<StudioLaunchBackend, "native">,
	launch: StudioLaunch,
	executable: string,
): number | undefined {
	const { spawnDetached } = backend.native();
	const { cwd, env } = launch;
	return (
		spawnDetached?.({
			args: studioArguments(launch),
			cwd,
			env: definedOnly(env),
			program: executable,
			...(launch.desktop === undefined ? {} : { desktop: launch.desktop }),
		}) ?? undefined
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
	launch: StudioLaunch,
	executable: string,
): Promise<number | string> {
	const { cwd, env } = launch;
	const child = backend.childProcess.spawn(executable, studioArguments(launch), {
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
	await launch.beforeLaunch?.();
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

	const desktop = backend.host.platform === "win32" ? (launch.desktop ?? "user") : "user";
	return {
		studio: {
			pid,
			startTime: pinned.startTime,
			...(launch.desktop === undefined ? {} : { desktop }),
		},
		type: "launched",
	};
}

async function launchStudioAsync(
	backend: StudioLaunchBackend,
	launch: StudioLaunch,
): Promise<StudioLaunchOutcome> {
	let executable: StudioExecutable | undefined;
	try {
		executable = findStudioExecutable(backend, launch);
	} catch (err) {
		// Only a bad override is a launch failure; `native_missing` keeps its
		// code.
		const error = toForgeError(err);
		if (error.code !== "studio_launch_failed") {
			throw error;
		}

		return { hint: error.hint, message: error.message, type: "failed" };
	}

	return executable === undefined
		? launchThroughPlatformAsync(backend, launch)
		: launchDirectAsync(backend, launch, executable.path);
}

function watchSnapshotLighting(
	watch: SnapshotLightingLauncher,
	launch: StudioLaunch,
	outcome: StudioLaunchOutcome,
): StudioLaunchOutcome {
	if (launch.watchHiddenLighting !== true || outcome.studio?.desktop !== "hidden") {
		return outcome;
	}

	try {
		watch({ cwd: launch.cwd, env: launch.env, place: launch.place, studio: outcome.studio });
		return outcome;
	} catch (err) {
		return {
			...outcome,
			type: "launched",
			warning: `Studio opened, but its automatic Lighting prompt watcher could not start: ${String(err)}`,
		};
	}
}
