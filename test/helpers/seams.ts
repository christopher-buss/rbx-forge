import { fromAny } from "@total-typescript/shoehorn";

import { memfs } from "memfs";
import path from "node:path";
import { vi } from "vitest";

import type { CommandContext } from "../../src/commands/context.ts";
import type { ProcessRunner } from "../../src/process/process-runner.ts";
import type { Clock } from "../../src/seams/clock.ts";
import type { ConfigLoader } from "../../src/seams/config-loader.ts";
import type { FileSystem } from "../../src/seams/file-system.ts";
import type { Host } from "../../src/seams/host.ts";
import type { Prompter } from "../../src/seams/prompter.ts";
import type {
	CommandFailure,
	CommandResult,
	Reporter,
	ReporterEvent,
} from "../../src/seams/reporter.ts";
import type { Seams } from "../../src/seams/seams.ts";
import type { StudioLauncher } from "../../src/studio/launcher.ts";

/** The project directory of every in-memory test project. */
export const PROJECT: string = path.resolve("/project");

/** An in-memory volume and the file system seam over it. */
export interface MemoryFileSystem {
	/** Every file in the project, by path relative to {@link PROJECT}. */
	files: () => Record<string, null | string>;
	fileSystem: FileSystem;
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
		fileSystem: createMemoryFileSystem().fileSystem,
		host: {
			execPath: "/node",
			kill: vi.fn<Host["kill"]>(unreachable("host kill")),
			platform: "linux",
		},
		native: unreachable("native addon"),
		processRunner: vi.fn<ProcessRunner>(unreachable("process runner")),
		prompter: {
			choose: vi.fn<Prompter["choose"]>(unreachable("prompter")),
			confirm: vi.fn<Prompter["confirm"]>(unreachable("prompter")),
		},
		studioLauncher: vi.fn<StudioLauncher>(unreachable("studio launcher")),
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
