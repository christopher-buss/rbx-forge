import type { NativeLoader } from "../native/addon.ts";
import type { ProcessRunner } from "../process/process-runner.ts";
import type { StudioLauncher } from "../studio/launcher.ts";
import type { ChildProcessRunner } from "./child-process.ts";
import type { Clock } from "./clock.ts";
import type { ConfigLoader } from "./config-loader.ts";
import type { FileSystem } from "./file-system.ts";
import type { Host } from "./host.ts";
import type { Prompter } from "./prompter.ts";

/**
 * Environment variables, read once at the CLI entry. No other module reads
 * `process.env`.
 */
export type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Every I/O dependency a command can reach, in one record. `src/cli.ts` is
 * the only place that builds it from the real implementations; everything
 * below takes it as a required argument, so nothing under test reaches the
 * real disk or a real process by omission. Unit tests build one with
 * `createTestSeams` (`test/helpers/seams.ts`).
 *
 * The reporter is not here: it depends on `--json`, so `cli/run-cli.ts`
 * builds it per run.
 */
export interface Seams {
	childProcess: ChildProcessRunner;
	clock: Clock;
	configLoader: ConfigLoader;
	fileSystem: FileSystem;
	host: Host;
	/** The `@rbx-forge/native` addon, loaded on first use. */
	native: NativeLoader;
	/**
	 * Runs tools and hooks to completion. Built from `childProcess` today;
	 * the native reaper replaces it without changing its callers.
	 */
	processRunner: ProcessRunner;
	prompter: Prompter;
	/** Opens a place in Studio outside every forge-owned process tree. */
	studioLauncher: StudioLauncher;
}
