/**
 * Detached sessions for e2e tests: `forge up` in a fixture project
 * (`session-fixture.ts`), and a cleanup that stops the session through its
 * control channel and waits until its supervisor is gone.
 */
import nodeFs from "node:fs";
import process from "node:process";
import { onTestFinished } from "vitest";

import { findSession } from "../../src/client/session.ts";
import { callSessionAsync } from "../../src/ipc/client.ts";
import { forgeFiles } from "../../src/supervisor/session-files.ts";
import { realTransport } from "../helpers/native-testing.ts";
import type { ResultLine } from "../helpers/output.ts";
import { parseResult } from "../helpers/output.ts";
import { isProcessAlive, waitForDeathAsync } from "../helpers/worker-log.ts";
import type { BinRun } from "./run-bin.ts";
import { runBinAsync } from "./run-bin.ts";
import type { Fixture } from "./session-fixture.ts";

/** Rojo alone: the quickest session. */
export const UP_ROJO_ONLY: ReadonlyArray<string> = ["up", "--no-open", "--no-compiler", "--json"];

/** One finished `forge` run with its parsed result. */
export interface UpRun extends BinRun {
	result: ResultLine;
}

/**
 * Stop the project's session, if one runs: `shutdown` over its control
 * channel, then wait for its supervisor to exit; kill it when it does not.
 *
 * @param project - The project directory.
 */
export async function stopDetachedAsync(project: string): Promise<void> {
	const session = findSession(nodeFs, forgeFiles(project));
	if (session === undefined) {
		return;
	}

	const { endpoint, pid } = session.identity;
	try {
		await callSessionAsync(realTransport(), { endpoint, token: session.token }, "shutdown");
	} catch {
		// Already stopping or gone.
	}

	const alive = await waitForDeathAsync([pid], 20_000);
	const survivors = alive.filter(isProcessAlive);
	for (const survivor of survivors) {
		process.kill(survivor, "SIGKILL");
	}
}

/**
 * Run `forge <argv>` in the fixture project, and stop any session it left
 * when the test ends.
 *
 * @param fixture - The project and its environment.
 * @param argv - Arguments after `forge`.
 * @param variables - Fixture variables for the workers and supervisor.
 * @returns The run and its result line.
 */
export async function runForgeAsync(
	fixture: Fixture,
	argv: ReadonlyArray<string>,
	variables: Record<string, string> = {},
): Promise<UpRun> {
	onTestFinished(async () => {
		await stopDetachedAsync(fixture.project);
	});
	const run = await runBinAsync([...argv], fixture.project, fixture.environment(variables));
	return { ...run, result: parseResult(run.stdout) };
}
