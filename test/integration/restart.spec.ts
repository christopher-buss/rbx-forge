/**
 * `restartParts` against a real supervisor and reaper: each old process
 * tree, grandchildren included, is gone before its part starts again.
 */
import nodeFs from "node:fs";
import { describe, expect, it } from "vitest";

import { findSession } from "../../src/client/session.ts";
import { callSessionAsync } from "../../src/ipc/client.ts";
import { parseStatus } from "../../src/session/status.ts";
import type { SessionRequest } from "../../src/supervisor/channel.ts";
import { forgeFiles } from "../../src/supervisor/session-files.ts";
import { realTransport } from "../helpers/native-testing.ts";
import type { WorkerRecord } from "../helpers/worker-log.ts";
import { isProcessAlive } from "../helpers/worker-log.ts";
import {
	launch,
	makeProjectAsync,
	waitForAsync,
	waitForReadyAsync,
	workersOf,
} from "./session-harness.ts";

const WITH_COMPILER: SessionRequest = { compiler: true, config: {}, open: false, rojo: true };
const WAIT_MS = 20_000;

/**
 * The worker leaders that started after a point.
 *
 * @param records - Every worker record now.
 * @param old - The records at that point.
 * @returns The leaders that are not in `old`.
 */
function leadersSince(
	records: ReadonlyArray<WorkerRecord>,
	old: ReadonlyArray<WorkerRecord>,
): Array<WorkerRecord> {
	const oldPids = new Set(old.map(({ pid }) => pid));
	return records.filter(({ pid, role }) => role !== "grandchild" && !oldPids.has(pid));
}

describe("restartParts", () => {
	it("should stop each tree until it is gone, then start the compiler and Rojo again with their owner", async () => {
		expect.assertions(4);

		const project = await makeProjectAsync({
			luau: { watch: { args: ["-w"], command: "rbxtsc" } },
		});
		const run = launch(project, WITH_COMPILER, { FIXTURE_GRANDCHILDREN: "1" });
		const session = await waitForAsync(() => findSession(nodeFs, forgeFiles(project.project)));
		const target = { endpoint: session.identity.endpoint, token: session.token };
		await waitForReadyAsync(run);
		const old = workersOf(project, session.identity.sessionId);
		const answer = await callSessionAsync(realTransport(), target, "restartParts", {
			params: { force: true },
			responseTimeoutMs: WAIT_MS,
		});
		const oldAlive = old.filter(({ pid }) => isProcessAlive(pid));
		const status = parseStatus(await callSessionAsync(realTransport(), target, "status"));
		const now = leadersSince(workersOf(project, session.identity.sessionId), old);
		run.stop("SIGINT");
		await run.settled;

		expect(answer).toStrictEqual({
			added: ["compiler", "rojo"],
			kept: [],
			stopped: ["rojo", "compiler"],
		});
		expect(oldAlive).toStrictEqual([]);
		expect(now.map(({ role }) => role).toSorted()).toStrictEqual(["rbxtsc", "rojo"]);
		expect(status!.services).toMatchObject({
			compiler: { owner: "start", status: "ready" },
			rojo: { owner: "start", status: "ready" },
		});
	}, 60_000);
});
