/**
 * Detached sessions for e2e tests: `forge up` in a fixture project
 * (`session-fixture.ts`), and a cleanup that stops the session with
 * `forge down --force` and makes sure its supervisor is gone.
 */
import { spawn } from "node:child_process";
import nodeFs from "node:fs";
import process from "node:process";
import { onTestFinished } from "vitest";

import { findSession } from "../../src/client/session.ts";
import { forgeFiles } from "../../src/supervisor/session-files.ts";
import type { ResultLine } from "../helpers/output.ts";
import { parseResult } from "../helpers/output.ts";
import { isProcessAlive, waitForDeathAsync } from "../helpers/worker-log.ts";
import type { BinRun } from "./run-bin.ts";
import { BIN, runBinAsync } from "./run-bin.ts";
import type { Fixture } from "./session-fixture.ts";

/** Rojo alone: the quickest session. */
export const UP_ROJO_ONLY: ReadonlyArray<string> = ["up", "--no-open", "--no-compiler", "--json"];

/** One finished `forge` run with its parsed result. */
export interface UpRun extends BinRun {
	result: ResultLine;
}

/**
 * Stop the project's session, if one runs: `forge down --force`; kill its
 * supervisor when it still runs after that.
 *
 * @param fixture - The project and its environment.
 */
export async function stopDetachedAsync(fixture: Fixture): Promise<void> {
	const session = findSession(nodeFs, forgeFiles(fixture.project));
	if (session === undefined) {
		return;
	}

	// Spawned here, not through `runBinAsync`: this runs in a test's cleanup.
	const down = spawn(process.execPath, [BIN, "down", "--force", "--json", "--timeout", "5"], {
		cwd: fixture.project,
		env: fixture.environment(),
		stdio: "ignore",
		windowsHide: true,
	});
	await new Promise((resolve) => {
		down.once("close", resolve);
	});
	const alive = await waitForDeathAsync([session.identity.pid], 5000);
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
		await stopDetachedAsync(fixture);
	});
	const run = await runBinAsync([...argv], fixture.project, fixture.environment(variables));
	return { ...run, result: parseResult(run.stdout) };
}
