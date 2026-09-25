import { fromAny } from "@total-typescript/shoehorn";

import { memfs } from "memfs";
import path from "node:path";
import { vi } from "vitest";

import type { CommandContext } from "../../src/commands/context.ts";
import type { IpcTransport } from "../../src/ipc/transport.ts";
import type { ProcessRunner } from "../../src/process/process-runner.ts";
import type { ReaperLauncher } from "../../src/reaper/reaper-client.ts";
import type { Clock } from "../../src/seams/clock.ts";
import type { ConfigLoader } from "../../src/seams/config-loader.ts";
import type { FileSystem } from "../../src/seams/file-system.ts";
import type { Host } from "../../src/seams/host.ts";
import type { Network } from "../../src/seams/network.ts";
import type { Prompter } from "../../src/seams/prompter.ts";
import type {
	CommandFailure,
	CommandResult,
	Reporter,
	ReporterEvent,
} from "../../src/seams/reporter.ts";
import type { Seams } from "../../src/seams/seams.ts";
import type { Signals } from "../../src/seams/signals.ts";
import type { StudioLauncher } from "../../src/studio/launcher.ts";
import type { DetachedLauncher } from "../../src/supervisor/detached-launcher.ts";
import type { SupervisorLauncher } from "../../src/supervisor/launcher.ts";

/** The project directory of every in-memory test project. */
export const PROJECT: string = path.resolve("/project");

/** The computer name of the test host. */
export const TEST_HOSTNAME = "forge-test";

/** An in-memory volume and the file system seam over it. */
export interface MemoryFileSystem {
	/** Every file in the project, by path relative to {@link PROJECT}. */
	files: () => Record<string, null | string>;
	fileSystem: FileSystem;
	/** Set a file's modification time, in milliseconds since the Unix epoch. */
	setModifiedTime: (file: string, mtimeMs: number) => void;
}

/** A reporter that records every call. */
export interface RecordingReporter extends Reporter {
	events: Array<ReporterEvent>;
	failures: Array<CommandFailure>;
	results: Array<{ command: string; result: CommandResult }>;
}

/**
 * A file system seam over a fresh memfs volume. Never uses memfs's shared
 * `vol`, so no state crosses tests.
 *
 * @param files - Seed files, by path relative to {@link PROJECT}.
 * @returns The seam and a reader for the volume.
 */
export function createMemoryFileSystem(files: Record<string, string> = {}): MemoryFileSystem {
	const { fs, vol } = memfs(files, PROJECT);
	vol.mkdirSync(PROJECT, { recursive: true });

	return {
		files: () => vol.toJSON(PROJECT, {}, true),
		// memfs implements the members the seam picks; its typings lag
		// `@types/node` under `exactOptionalPropertyTypes`.
		fileSystem: fromAny(fs),
		setModifiedTime: (file, mtimeMs) => {
			vol.utimesSync(path.resolve(PROJECT, file), mtimeMs / 1000, mtimeMs / 1000);
		},
	};
}

/**
 * Seams for a unit test: memfs, a fake clock, and seams that throw when a test
 * reaches them without passing its own.
 *
 * @param overrides - The seams this test provides.
 * @returns A full seam record.
 */
export function createTestSeams(overrides: Partial<Seams> = {}): Seams {
	return {
		childProcess: { spawn: unreachable("child process") },
		// A clock that stands still: `sleep` resolves at once.
		clock: {
			now: () => Date.UTC(2026, 0, 1),
			sleep: vi.fn<Clock["sleep"]>().mockResolvedValue(undefined),
		},
		configLoader: vi.fn<ConfigLoader>(unreachable("config loader")),
		detachedSupervisor: vi.fn<DetachedLauncher>(unreachable("detached supervisor")),
		fileSystem: createMemoryFileSystem().fileSystem,
		host: createTestHost(),
		ipc: {
			connectAsync: vi.fn<IpcTransport["connectAsync"]>(unreachable("ipc")),
			listenAsync: vi.fn<IpcTransport["listenAsync"]>(unreachable("ipc")),
		},
		native: unreachable("native addon"),
		network: { isPortFreeAsync: vi.fn<Network["isPortFreeAsync"]>(unreachable("network")) },
		processRunner: vi.fn<ProcessRunner>(unreachable("process runner")),
		prompter: {
			choose: vi.fn<Prompter["choose"]>(unreachable("prompter")),
			confirm: vi.fn<Prompter["confirm"]>(unreachable("prompter")),
		},
		randomId: vi.fn<() => string>(unreachable("random id")),
		reaper: vi.fn<ReaperLauncher>(unreachable("reaper")),
		signals: { onStop: vi.fn<Signals["onStop"]>(unreachable("signals")) },
		studioLauncher: vi.fn<StudioLauncher>(unreachable("studio launcher")),
		supervisor: vi.fn<SupervisorLauncher>(unreachable("supervisor")),
		...overrides,
	};
}

/**
 * A reporter that keeps what it is given, for assertions.
 *
 * @returns A reporter that keeps every event, failure, and result.
 */
export function createRecordingReporter(): RecordingReporter {
	const events: Array<ReporterEvent> = [];
	const failures: Array<CommandFailure> = [];
	const results: Array<{ command: string; result: CommandResult }> = [];

	return {
		emit: (event) => {
			events.push(event);
		},
		events,
		fail: (failure) => {
			failures.push(failure);
		},
		failures,
		results,
		succeed: (command, result) => {
			results.push({ command, result });
		},
	};
}

/**
 * A command context for unit tests.
 *
 * @param overrides - Fields this test sets.
 * @returns A non-interactive context over test seams.
 */
export function createCommandContext(overrides: Partial<CommandContext> = {}): CommandContext {
	return {
		cwd: PROJECT,
		env: {},
		interactive: false,
		reporter: createRecordingReporter(),
		seams: createTestSeams(),
		...overrides,
	};
}

function unreachable(seam: string): () => never {
	return () => {
		throw new Error(`the test reached the ${seam} seam without providing it`);
	};
}

/**
 * The test host: Linux, PID 4242, user 1000, booted at the epoch.
 *
 * @returns A host whose `kill` throws unless a test replaces it.
 */
function createTestHost(): Host {
	return {
		bootTimeMs: () => 0,
		execPath: "/node",
		hostname: TEST_HOSTNAME,
		kill: vi.fn<Host["kill"]>(unreachable("host kill")),
		pid: 4242,
		platform: "linux",
		userId: 1000,
	};
}
