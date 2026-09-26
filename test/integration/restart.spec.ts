/**
 * `restartParts` against a real supervisor and reaper: each old process
 * tree, grandchildren included, is gone before its part starts again.
 */
import nodeFs from "node:fs";
import { describe, expect, it } from "vitest";

import { findSession } from "../../src/client/session.ts";
import { callSessionAsync } from "../../src/ipc/client.ts";
import type { SessionStatus } from "../../src/session/status.ts";
import { parseStatus } from "../../src/session/status.ts";
import type { SessionRequest } from "../../src/supervisor/channel.ts";
import { forgeFiles } from "../../src/supervisor/session-files.ts";
import { realTransport } from "../helpers/native-testing.ts";
import type { WorkerRecord } from "../helpers/worker-log.ts";
import { isProcessAlive, readWorkerLog } from "../helpers/worker-log.ts";
import type { Project } from "./session-harness.ts";
import {
	COMPILER_ONLY,
	launch,
	makeProjectAsync,
	START_ALL,
	studioEnvironment,
	waitForAsync,
	waitForReadyAsync,
} from "./session-harness.ts";

const WAIT_MS = 20_000;

/** What one forced restart did, and the session after it. */
interface Restarted {
	/** The answer of `restartParts`. */
	answer: unknown;
	/** The roles of the long-running processes that started after it. */
	now: Array<string>;
	/** The processes from before the restart that still ran after it. */
	oldAlive: Array<WorkerRecord>;
	status: SessionStatus | undefined;
}

/**
 * Wait until the long-running leaders that started after a point have all
 * logged their start, and each one but Studio its grandchild: a part is
 * ready before the fixture logs it, and a one-shot `rojo build` is no
 * leader.
 *
 * @param project - Where the session runs.
 * @param old - The records at that point.
 * @param leaders - How many leaders started.
 * @returns Every record now, and the leaders not in `old`.
 */
async function treesSinceAsync(
	project: Project,
	old: ReadonlyArray<WorkerRecord>,
	leaders: number,
): Promise<{ records: Array<WorkerRecord>; started: Array<WorkerRecord> }> {
	const oldPids = new Set(old.map(({ pid }) => pid));
	return waitForAsync(() => {
		const records = readWorkerLog(project.log);
		const started = records.filter(({ args, pid, role }) => {
			return role !== "grandchild" && !args.includes("build") && !oldPids.has(pid);
		});
		const isComplete = started
			.filter(({ role }) => role !== "studio")
			.every(({ pid }) => {
				return records.some(({ ppid, role }) => ppid === pid && role === "grandchild");
			});
		return isComplete && started.length >= leaders ? { records, started } : undefined;
	});
}

/**
 * Start a session whose processes each have a grandchild, restart its parts
 * with `force`, wait until its new processes have started, and stop it.
 *
 * @param project - Where it runs.
 * @param request - What `start` asks for.
 * @param leaders - How many long-running processes the restart starts.
 * @param variables - More fixture variables.
 * @returns What the restart did.
 */
async function restartAsync(
	project: Project,
	request: SessionRequest,
	leaders: number,
	variables: Record<string, string> = {},
): Promise<Restarted> {
	const run = launch(project, request, { ...variables, FIXTURE_GRANDCHILDREN: "1" });
	const session = await waitForAsync(() => findSession(nodeFs, forgeFiles(project.project)));
	const target = { endpoint: session.identity.endpoint, token: session.token };
	await waitForReadyAsync(run);
	const { records: old } = await treesSinceAsync(project, [], leaders);
	const answer = await callSessionAsync(realTransport(), target, "restartParts", {
		params: { force: true },
		responseTimeoutMs: WAIT_MS,
	});
	const oldAlive = old.filter(({ pid }) => isProcessAlive(pid));
	const status = parseStatus(await callSessionAsync(realTransport(), target, "status"));
	const { started } = await treesSinceAsync(project, old, leaders);
	run.stop("SIGINT");
	await run.settled;
	return { answer, now: started.map(({ role }) => role).toSorted(), oldAlive, status };
}

describe("restartParts", () => {
	it("should stop the compiler's tree until it is gone, then start the compiler again with its owner", async () => {
		expect.assertions(4);

		const project = await makeProjectAsync();
		const { answer, now, oldAlive, status } = await restartAsync(project, COMPILER_ONLY, 1);

		expect(answer).toStrictEqual({ added: ["compiler"], kept: [], stopped: ["compiler"] });
		expect(oldAlive).toStrictEqual([]);
		expect(now).toStrictEqual(["rbxtsc"]);
		expect(status!.services).toMatchObject({
			compiler: { owner: "start", status: "ready" },
			rojo: { owner: null, status: "off" },
		});
	}, 60_000);

	it("should stop each tree until it is gone, then start Studio, Rojo, and the compiler again with their owner", async () => {
		expect.assertions(4);

		const project = await makeProjectAsync({ studio: { autoRecovery: "keep" } });
		const { answer, now, oldAlive, status } = await restartAsync(
			project,
			START_ALL,
			3,
			studioEnvironment(project),
		);

		expect(answer).toMatchObject({
			added: ["compiler", "studio", "rojo"],
			kept: [],
			stopped: ["studio", "rojo", "compiler"],
			studio: { stop: { forced: false, status: "stopped" } },
		});
		expect(oldAlive).toStrictEqual([]);
		expect(now).toStrictEqual(["rbxtsc", "rojo", "studio"]);
		expect(status!.services).toMatchObject({
			compiler: { owner: "start", status: "ready" },
			rojo: { owner: "start", status: "ready" },
			studio: { owner: "start", status: "open" },
		});
	}, 60_000);
});
