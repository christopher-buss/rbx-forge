/**
 * Detached sessions for e2e tests: `forge up` in a fixture project
 * (`session-fixture.ts`), and a cleanup that stops the session with
 * `forge down --force` and makes sure its supervisor is gone.
 */
import nodeFs from "node:fs";
import { onTestFinished } from "vitest";

import { findSession } from "../../src/client/session.ts";
import { forgeFiles } from "../../src/supervisor/session-files.ts";
import type { ResultLine } from "../helpers/output.ts";
import { parseResult } from "../helpers/output.ts";
import { pinNow, waitForDeathAsync } from "../helpers/worker-log.ts";
import type { BinRun, BinRunOptions } from "./run-bin.ts";
import { runBinAsync } from "./run-bin.ts";
import type { Fixture } from "./session-fixture.ts";

/** `forge up`: the watch-mode compiler alone. */
export const UP: ReadonlyArray<string> = ["up", "--json"];

/**
 * Config for a Luau project whose watch command is the fake compiler: a
 * worker that runs until stopped and is ready once it runs.
 */
export const WATCH_COMMAND: Readonly<Record<string, unknown>> = {
	luau: { watch: { args: ["-w"], command: "rbxtsc" } },
};

/** One finished `forge` run with its parsed result. */
export interface UpRun extends BinRun {
	result: ResultLine;
}

/**
 * Stop the project's session, if one runs: `forge down --force`; kill its
 * supervisor when it still runs after that.
 *
 * @param fixture - The project and its environment.
 * @param timeoutMs - The cleanup command's deadline, before the hook deadline.
 */
export async function stopDetachedAsync(fixture: Fixture, timeoutMs = 15_000): Promise<void> {
	const session = findSession(nodeFs, forgeFiles(fixture.project));
	if (session === undefined) {
		return;
	}

	const pin = pinNow(session.identity.pid);
	try {
		await runBinAsync(
			["down", "--force", "--json", "--timeout", "5"],
			fixture.project,
			fixture.environment(),
			{ registerCleanup: false, timeoutMs },
		);
	} finally {
		await waitForDeathAsync([session.identity.pid], 5000);
		// The pin retains the recorded identity across the cleanup command.
		if (pin?.startTime === session.identity.processStartTime) {
			pin.kill();
		}

		await waitForDeathAsync([session.identity.pid], 1000);
	}
}

/**
 * Run `forge <argv>` in the fixture project, and stop any session it left
 * when the test ends.
 *
 * @param fixture - The project and its environment.
 * @param argv - Arguments after `forge`.
 * @param variables - Fixture variables for the workers and supervisor.
 * @param options - The subprocess deadline.
 * @returns The run and its result line.
 */
export async function runForgeAsync(
	fixture: Fixture,
	argv: ReadonlyArray<string>,
	variables: Record<string, string> = {},
	options: BinRunOptions = {},
): Promise<UpRun> {
	onTestFinished(async () => {
		await stopDetachedAsync(fixture);
	});
	const run = await runBinAsync(
		[...argv],
		fixture.project,
		fixture.environment(variables),
		options,
	);
	return { ...run, result: parseResult(run.stdout) };
}
