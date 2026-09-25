import assert from "node:assert/strict";
import { once } from "node:events";
import path from "node:path";

import type { CommandContext } from "../commands/context.ts";
import { toForgeError } from "../errors.ts";
import { requireSyncbackAsync } from "../rojo/rojo.ts";
import type { SyncbackTarget } from "../syncback/syncback.ts";
import { resolveSyncbackTarget, runSyncbackAsync } from "../syncback/syncback.ts";
import type { CoalescingRunner } from "./coalesce.ts";
import { createCoalescingRunner } from "./coalesce.ts";
import type { SessionScope } from "./run-session.ts";
import type { SessionSetup } from "./session-body.ts";
import type { SyncbackAttempt } from "./session-sync.ts";
import type { SyncbackRun } from "./status.ts";
import { parseHookResults } from "./status.ts";
import type { WatchOptions } from "./watch.ts";
import { watchSavesAsync } from "./watch.ts";

// Syncback in a session: one runner per session, shared by
// the save watch and `forge sync`, so syncback and its hooks run one at a
// time, with requests during a run folded into one more run.

/** Checks that Rojo has syncback, through a given context. */
export type SyncbackCheck = (context: CommandContext) => Promise<void>;

/**
 * Check Rojo's syncback support once per session: a check that passed is
 * kept, so saves and `forge sync` do not ask Rojo each time. A failed check
 * is not kept, so the next run checks again.
 *
 * @param config - Holds `rojoAlias`.
 * @returns The session's check.
 */
export function checkSyncbackOnce(config: SessionSetup["config"]): SyncbackCheck {
	let passed: Promise<void> | undefined;
	return async (context) => {
		passed ??= requireSyncbackAsync(context, config).catch((err: unknown) => {
			passed = undefined;
			throw err;
		});
		await passed;
	};
}

/**
 * The session's syncback runner: one run at a time, for the save watch and
 * `forge sync` alike. Hands it to `forge sync`.
 *
 * @param session - The config, context, and `forge sync` link.
 * @param scope - Its end signal.
 * @param runs - The context runs go through (the session's reaper), and the
 *   session's check of Rojo's syncback support.
 * @returns The runner.
 */
export function startSyncback(
	session: SessionSetup,
	scope: SessionScope,
	runs: { context: CommandContext; requireSyncback: SyncbackCheck },
): CoalescingRunner<SyncbackAttempt> {
	const run = { ...runs, target: resolveSyncbackTarget(session.config) };
	const runner = createCoalescingRunner(async () => syncbackOnceAsync(session, scope, run));
	session.sync.attach(runner.request);
	// The runs end with the session either way; tracking orders them.
	// Stryker disable next-line CallExpression: equivalent
	scope.track(closeSyncbackAsync(session, scope, runner));
	return runner;
}

/**
 * Run syncback with its hooks on every place save, until the session ends.
 *
 * @param session - The config and context.
 * @param options - How the place is watched, and the session's end signal.
 * @param runner - The session's syncback runner.
 */
export async function watchSavesForSyncbackAsync(
	{ config, context }: Pick<SessionSetup, "config" | "context">,
	options: WatchOptions,
	runner: CoalescingRunner<SyncbackAttempt>,
): Promise<void> {
	const place = path.resolve(context.cwd, resolveSyncbackTarget(config).input);
	await watchSavesAsync(options, place, () => {
		// A run never rejects; its outcome is in the status.
		void runner.request();
	});
}

function describeError(error: unknown): string {
	// Steps fail only with errors.
	assert(error instanceof Error);
	return error.message;
}

/**
 * The status record of a failed syncback run: its error and the hooks that
 * ran before it failed.
 *
 * @param error - What the run rejected with.
 * @param durationMs - How long it ran.
 * @returns A run with `ok: false`, the error's code and message, and the
 *   hooks its details carry.
 */
function failedRun(error: unknown, durationMs: number): SyncbackRun {
	const { code, details, message } = toForgeError(error);
	const hooks = parseHookResults(details?.["hooks"]);
	return { durationMs, error: { code, message }, hooks, ok: false };
}

/**
 * One syncback run with its hooks, kept in the status and reported.
 *
 * @param session - The config, context, and status.
 * @param scope - Its end signal.
 * @param run - The worker context, the check, and the target.
 * @returns How the run ended; never rejects.
 */
async function syncbackOnceAsync(
	{ config, context, status }: SessionSetup,
	scope: SessionScope,
	run: { context: CommandContext; requireSyncback: SyncbackCheck; target: SyncbackTarget },
): Promise<SyncbackAttempt> {
	const { reporter } = context;
	const { clock } = context.seams;
	const started = clock.now();
	status.syncbackStarted();
	try {
		await run.requireSyncback(run.context);
		const { hooks, value } = await runSyncbackAsync(run.context, config, run.target);
		status.syncbackFinished({ durationMs: clock.now() - started, hooks, ok: true });
		reporter.emit({
			message: `Synced ${value.input} into ${value.project}.`,
			type: "info",
		});
		return { hooks, ok: true, value };
	} catch (err) {
		status.syncbackFinished(failedRun(err, clock.now() - started));
		// A run the session's end cut short is not a failure to report.
		if (!scope.signal.aborted) {
			reporter.emit({
				message: `Syncback failed: ${describeError(err)}`,
				type: "warning",
			});
		}

		return { error: err, ok: false };
	}
}

async function abortedAsync(signal: AbortSignal): Promise<void> {
	if (!signal.aborted) {
		await once(signal, "abort");
	}
}

/**
 * Once the session ends, refuse new `forge sync` requests and wait for the
 * runs still going.
 *
 * @param session - Its `forge sync` link.
 * @param scope - Its end signal.
 * @param runner - The session's syncback runner.
 */
async function closeSyncbackAsync(
	session: SessionSetup,
	scope: SessionScope,
	runner: CoalescingRunner<SyncbackAttempt>,
): Promise<void> {
	await abortedAsync(scope.signal);
	session.sync.close();
	await runner.settled();
}
