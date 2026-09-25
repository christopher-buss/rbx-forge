import type { DiagnosticsParser } from "../compiler/diagnostics.ts";
import { createDiagnosticsParser } from "../compiler/diagnostics.ts";
import type { BuildEvent, FreshnessTracker } from "../compiler/freshness.ts";
import { createFreshnessTracker } from "../compiler/freshness.ts";
import { ForgeError } from "../errors.ts";
import type { Clock } from "../seams/clock.ts";
import type { LastBuild, StatusRecorder } from "./status.ts";

/** How long `forge status --wait` waits for a fresh build by default. */
export const FRESH_BUILD_TIMEOUT_MS = 300_000;

/** The builds of a session's watch-mode compiler, and the waits for them. */
export interface BuildWatch {
	/** The session is stopping: every wait fails with `not_running`. */
	close: () => void;
	/**
	 * Every wait, now and later, fails with `error`. The first failure
	 * wins.
	 */
	fail: (error: ForgeError) => void;
	/**
	 * Read one line of the compiler's output.
	 *
	 * @returns The build a summary line ended, else `undefined`.
	 */
	read: (line: string) => LastBuild | undefined;
	/** Let time pass with no output, such as before a status is read. */
	tick: () => void;
	/**
	 * Wait until the last build is fresh: no compile runs, and none started
	 * for one quiet window since the call or the last build.
	 *
	 * @rejects {ForgeError} `compile_timeout` after `timeoutMs`; the failure
	 *   given to `fail` or `close`.
	 */
	waitAsync: (timeoutMs: number) => Promise<void>;
}

/** What a build watch runs with. */
export interface BuildWatchOptions {
	clock: Clock;
	/** Gets each compile's start and build. */
	recorder: Pick<StatusRecorder, "building" | "compiled">;
	/**
	 * The session runs a compiler whose builds it reads. When not, a wait
	 * ends at once.
	 */
	tracks: boolean;
}

/** One build watch's parts. */
interface Watch {
	/** Resolves on the next line or failure; then a new one takes its place. */
	change: PromiseWithResolvers<void>;
	clock: Clock;
	failure: ForgeError | undefined;
	parser: DiagnosticsParser;
	recorder: BuildWatchOptions["recorder"];
	tracker: FreshnessTracker;
}

/** An output line that neither starts nor ends a compile. */
const OUTPUT: BuildEvent = { type: "output" };

/**
 * Watch the builds of a session's roblox-ts compiler, for a status wait: its
 * output lines become build events for a freshness tracker.
 *
 * @param options - The clock, the status, and whether a compiler is read.
 * @returns A watch with no build.
 */
export function createBuildWatch({ clock, recorder, tracks }: BuildWatchOptions): BuildWatch {
	const watch: Watch = {
		change: Promise.withResolvers(),
		clock,
		failure: undefined,
		parser: createDiagnosticsParser(),
		recorder,
		tracker: createFreshnessTracker(),
	};
	return {
		close: () => {
			fail(watch, stopping());
		},
		fail: (error) => {
			fail(watch, error);
		},
		read: (line) => read(watch, line),
		tick: () => {
			tick(watch);
		},
		waitAsync: async (timeoutMs) => {
			if (tracks) {
				await waitFreshAsync(watch, timeoutMs);
			}
		},
	};
}

function changed(watch: Watch): void {
	watch.change.resolve();
	watch.change = Promise.withResolvers();
}

function fail(watch: Watch, error: ForgeError): void {
	watch.failure ??= error;
	changed(watch);
}

function stopping(): ForgeError {
	return new ForgeError("not_running", "The session is stopping; no build comes.", {
		hint: 'Start a session with "forge up".',
	});
}

function tick(watch: Watch): void {
	if (watch.tracker.tick(watch.clock.now())) {
		watch.recorder.building(false);
	}
}

function read(watch: Watch, line: string): LastBuild | undefined {
	const { clock, parser, recorder, tracker } = watch;
	tick(watch);
	const wasBuilding = tracker.building();
	const build = tracker.record(parser.read(line) ?? OUTPUT, clock.now());
	if (build !== undefined) {
		recorder.compiled(build);
	}

	if (tracker.building() !== wasBuilding) {
		recorder.building(!wasBuilding);
	}

	changed(watch);
	return build;
}

function ignore(): void {
	// The timer was aborted; nothing waits for it.
}

/**
 * Sleep until `ms` passed or the watch changes.
 *
 * @param watch - Its clock and change signal.
 * @param ms - The longest sleep.
 */
async function sleepUntilChangeAsync(watch: Watch, ms: number): Promise<void> {
	const abort = new AbortController();
	const timer = watch.clock.sleep(ms, abort.signal).catch(ignore);
	await Promise.race([watch.change.promise, timer]);
	abort.abort();
}

function timedOut(tracker: FreshnessTracker, timeoutMs: number): ForgeError {
	const isBuilding = tracker.building();
	let why = "compiles kept starting";
	if (isBuilding) {
		why = "a compile still runs";
	} else if (tracker.lastBuild() === undefined) {
		why = "the first compile has not ended";
	}

	return new ForgeError("compile_timeout", `No fresh build within ${timeoutMs} ms: ${why}.`, {
		details: { building: isBuilding, timeoutMs },
		hint: 'Read the compiler\'s output with "forge logs compiler", or wait longer with --timeout.',
	});
}

/**
 * The loop of {@link BuildWatch.waitAsync}: wake at each line, at the end of
 * the quiet window, when merged start lines settle, and at the deadline.
 *
 * @param watch - The builds and the clock.
 * @param timeoutMs - How long the wait may take.
 * @rejects {ForgeError} As {@link BuildWatch.waitAsync}.
 */
async function waitFreshAsync(watch: Watch, timeoutMs: number): Promise<void> {
	const { clock, tracker } = watch;
	const since = clock.now();
	const deadline = since + timeoutMs;
	for (;;) {
		if (watch.failure !== undefined) {
			throw watch.failure;
		}

		tick(watch);
		const now = clock.now();
		const freshAt = tracker.freshAt(since);
		if (freshAt !== undefined && now >= freshAt) {
			return;
		}

		if (now >= deadline) {
			throw timedOut(tracker, timeoutMs);
		}

		const wakeAt = Math.min(freshAt ?? deadline, tracker.settleAt() ?? deadline, deadline);
		await sleepUntilChangeAsync(watch, wakeAt - now);
	}
}
