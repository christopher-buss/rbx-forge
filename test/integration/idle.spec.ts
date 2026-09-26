/**
 * The idle timeout against a real supervisor on the real clock. The config
 * takes a fraction of a minute, so each test waits a few seconds.
 */
import nodeFs, { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { assert, describe, expect, it } from "vitest";

import { findSession } from "../../src/client/session.ts";
import { callSessionAsync } from "../../src/ipc/client.ts";
import type { ReporterEvent } from "../../src/seams/reporter.ts";
import type { SessionRequest } from "../../src/supervisor/channel.ts";
import { forgeFiles } from "../../src/supervisor/session-files.ts";
import { studioPlaceContent } from "../fixtures/bin/studio-stand-in.ts";
import { realTransport } from "../helpers/native-testing.ts";
import { makeStudioExecutable, studioVariables } from "../helpers/real-native.ts";
import { makeTemporaryDirectory } from "../helpers/temporary-directory.ts";
import { isProcessAlive, readWorkerLog } from "../helpers/worker-log.ts";
import type { Launched, Project } from "./session-harness.ts";
import { launch, makeProjectAsync, settledWithinAsync, waitForAsync } from "./session-harness.ts";

/** What `forge up` asks for: the compiler alone. */
const UP: SessionRequest = { compiler: true, config: {}, open: false, rojo: false };
/** What `forge start` asks for in a Luau project: Studio and Rojo. */
const START_STUDIO: SessionRequest = { compiler: false, config: {}, open: true, rojo: true };
/** 1.2 s with no activity. */
const SHORT_TIMEOUT = 0.02;
/** 3 s with no activity: longer than the time between two activities. */
const TIMEOUT = 0.05;
const TIMEOUT_MS = TIMEOUT * 60_000;
const ACTIVITY_EVERY_MS = 1000;
/** How long the activity goes on: longer than the timeout. */
const ACTIVE_MS = 5000;
const SETTLE_MS = 15_000;

/**
 * Start an up session in a roblox-ts project whose compiler watches
 * `src/main.ts`.
 *
 * @param idleTimeout - `session.idleTimeout`, in minutes.
 * @returns The project, the watched file, and the supervisor.
 */
async function startUpAsync(
	idleTimeout: number,
): Promise<{ project: Project; run: Launched; watched: string }> {
	const project = await makeProjectAsync({ projectType: "rbxts", session: { idleTimeout } });
	const watched = path.join(project.project, "src", "main.ts");
	mkdirSync(path.dirname(watched), { recursive: true });
	writeFileSync(watched, "export {};\n");
	const run = launch(project, UP, { FIXTURE_COMPILER_WATCH: watched });
	return { project, run, watched };
}

/**
 * The variables of a session that opens a stand-in Studio, with a scratch
 * home, so no auto-recovery file of the user's Studio is ever touched.
 *
 * @returns The variables.
 */
function studioEnvironment(): Record<string, string> {
	const home = makeTemporaryDirectory();
	return {
		FIXTURE_PLACE_CONTENT: studioPlaceContent(),
		HOME: home,
		LOCALAPPDATA: path.join(home, "AppData", "Local"),
		// With an `--import`, Node loads the place as ESM, and the stand-in
		// does not run.
		NODE_OPTIONS: "",
		USERPROFILE: home,
		...studioVariables(makeStudioExecutable()),
	};
}

function isStudioOpen(event: ReporterEvent): boolean {
	return event.type === "info" && event.message.startsWith("Roblox Studio has");
}

/**
 * Do something every second for longer than the timeout, then check that
 * the session still runs.
 *
 * @param run - The supervisor.
 * @param act - One activity.
 */
async function keepActiveAsync(run: Launched, act: () => Promise<void> | void): Promise<void> {
	let isSettled = false;
	void run.settled.finally(() => {
		isSettled = true;
	});
	const until = Date.now() + ACTIVE_MS;
	while (Date.now() < until) {
		await act();
		await sleep(ACTIVITY_EVERY_MS);
	}

	expect(isSettled).toBeFalse();
}

/**
 * Wait until the supervisor ended after the idle timeout, and read its
 * reason.
 *
 * @param run - The supervisor.
 * @returns Its end reason.
 */
async function idleEndAsync(run: Launched): Promise<unknown> {
	const settled = await settledWithinAsync(run, "idle timeout", SETTLE_MS);
	assert(settled.ok, "expected the session to end");
	return settled.result.data["reason"];
}

describe("idle timeout", () => {
	it("should stop the compiler and end an up session with no activity", async () => {
		expect.assertions(3);

		const { project, run } = await startUpAsync(SHORT_TIMEOUT);

		await expect(idleEndAsync(run)).resolves.toBe("shutdown");
		expect(run.events).toContainEqual({
			message: `No activity for ${SHORT_TIMEOUT} min: stopped compiler.`,
			type: "info",
		});
		expect(readWorkerLog(project.log).filter(({ pid }) => isProcessAlive(pid))).toStrictEqual(
			[],
		);
	});

	it("should start the time again on each client request", async () => {
		expect.assertions(2);

		const { project, run } = await startUpAsync(TIMEOUT);
		const session = await waitForAsync(() => findSession(nodeFs, forgeFiles(project.project)));
		const target = { endpoint: session.identity.endpoint, token: session.token };
		const transport = realTransport();
		await keepActiveAsync(run, async () => {
			await callSessionAsync(transport, target, "status");
		});

		await expect(idleEndAsync(run)).resolves.toBe("shutdown");
	});

	it("should start the time again on each compile start", async () => {
		expect.assertions(2);

		const { run, watched } = await startUpAsync(TIMEOUT);
		let edits = 0;
		await keepActiveAsync(run, () => {
			edits += 1;
			writeFileSync(watched, `export const edit = ${edits};\n`);
		});

		await expect(idleEndAsync(run)).resolves.toBe("shutdown");
	});

	it(
		"should start the time again on each Studio save, then close Studio",
		{ timeout: 40_000 },
		async () => {
			expect.assertions(4);

			const project = await makeProjectAsync({
				session: { idleTimeout: TIMEOUT },
				studio: { autoRecovery: "keep" },
			});
			const place = path.join(project.project, "game.rbxl");
			const run = launch(project, START_STUDIO, studioEnvironment());
			await waitForAsync(() => run.events.find(isStudioOpen));
			const opened = Date.now();
			await keepActiveAsync(run, () => {
				const now = new Date();
				utimesSync(place, now, now);
			});
			const reason = await idleEndAsync(run);

			// The idle stop closes Studio, whose close ends the session too.
			expect(["shutdown", "studio_closed"]).toContain(reason);
			expect(Date.now() - opened).toBeGreaterThan(ACTIVE_MS + TIMEOUT_MS - ACTIVITY_EVERY_MS);
			expect(existsSync(`${place}.lock`)).toBeFalse();
		},
	);
});
