/**
 * The idle timeout against a real supervisor on the real clock. The config
 * takes a fraction of a minute, so each test waits a few seconds.
 */
import nodeFs, { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { TestContext } from "vitest";
import { assert, describe, it } from "vitest";

import type { KnownSession } from "../../src/client/session.ts";
import { findSession } from "../../src/client/session.ts";
import { callSessionAsync } from "../../src/ipc/client.ts";
import type { ReporterEvent } from "../../src/seams/reporter.ts";
import type { SessionStatus } from "../../src/session/status.ts";
import { parseStatus } from "../../src/session/status.ts";
import { forgeFiles } from "../../src/supervisor/session-files.ts";
import { realTransport } from "../helpers/native-testing.ts";
import { openStudioStandInAsync, pidOf, waitForFileAsync } from "../helpers/real-native.ts";
import { isProcessAlive, readWorkerLog } from "../helpers/worker-log.ts";
import type { Launched, Project, Settled } from "./session-harness.ts";
import {
	COMPILER_ONLY,
	currentIdentity,
	launch,
	launchUnowned,
	makeProjectAsync,
	native,
	settledWithinAsync,
	START_STUDIO,
	studioEnvironment,
	waitForAsync,
	workersOf,
} from "./session-harness.ts";
import { waitForSessionAsync } from "./session-reach.ts";

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
	const run = launchUnowned(project, COMPILER_ONLY, { FIXTURE_COMPILER_WATCH: watched });
	return { project, run, watched };
}

function isIdleStop(event: ReporterEvent): boolean {
	return event.type === "info" && event.message.startsWith("No activity for");
}

function savedStatus(session: KnownSession | undefined): SessionStatus | undefined {
	try {
		return session === undefined
			? undefined
			: parseStatus(JSON.parse(readFileSync(session.files.state, "utf8")));
	} catch {
		return undefined;
	}
}

/**
 * Ask the project's session for its status until `isDone` holds.
 *
 * @param project - Where it runs.
 * @param run - The supervisor being observed.
 * @param isDone - The condition.
 * @returns That status.
 * @rejects When the observation fails, with status and lifecycle evidence.
 */
async function waitForStatusAsync(
	project: Project,
	run: Launched,
	isDone: (status: SessionStatus) => boolean,
): Promise<SessionStatus> {
	const started = Date.now();
	let session = findSession(nodeFs, forgeFiles(project.project));
	let lastStatus: SessionStatus | undefined;
	let outcome: Settled | undefined;
	let eventsBeforeRequest = run.events.length;
	void run.settled.then((settled) => {
		outcome = settled;
	});
	try {
		session = await waitForSessionAsync(project);
		const target = { endpoint: session.identity.endpoint, token: session.token };
		const transport = realTransport();
		for (;;) {
			if (outcome !== undefined) {
				throw new Error("The supervisor exited before the expected status.");
			}

			if (Date.now() - started > SETTLE_MS) {
				throw new Error("The expected status was not observed in time.");
			}

			eventsBeforeRequest = run.events.length;
			lastStatus = parseStatus(await callSessionAsync(transport, target, "status"));
			if (lastStatus !== undefined && isDone(lastStatus)) {
				return lastStatus;
			}

			await sleep(100);
		}
	} catch (err) {
		session ??= findSession(nodeFs, forgeFiles(project.project));
		const pin = session === undefined ? null : native.pinProcess(session.identity.pid);
		const evidence = {
			elapsedMs: Date.now() - started,
			events: run.events,
			eventsBeforeRequest,
			identity: session?.identity,
			lastStatus,
			outcome: outcome ?? "pending",
			savedStatus: savedStatus(session),
			supervisorAlive:
				pin !== null &&
				pin.startTime === session?.identity.processStartTime &&
				pin.isAlive(),
		};
		throw new Error(`Idle status observation failed: ${JSON.stringify(evidence)}`, {
			cause: err,
		});
	}
}

/**
 * Do something every second for longer than the timeout, then check that
 * the session still runs.
 *
 * @param testContext - Assertions and cleanup for this test.
 * @param run - The supervisor.
 * @param act - One activity.
 */
async function keepActiveAsync(
	testContext: Pick<TestContext, "expect">,
	run: Launched,
	act: () => Promise<void> | void,
): Promise<void> {
	let isSettled = false;
	void run.settled.finally(() => {
		isSettled = true;
	});
	const until = Date.now() + ACTIVE_MS;
	while (Date.now() < until) {
		await act();
		await sleep(ACTIVITY_EVERY_MS);
	}

	testContext.expect(isSettled).toBeFalse();
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
	it("should stop the compiler and end an up session with no activity", async ({ expect }) => {
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

	it("should start the time again on each client request", async ({ expect }) => {
		expect.assertions(2);

		const { project, run } = await startUpAsync(TIMEOUT);
		const session = await waitForSessionAsync(project);
		const target = { endpoint: session.identity.endpoint, token: session.token };
		const transport = realTransport();
		await keepActiveAsync({ expect }, run, async () => {
			await callSessionAsync(transport, target, "status");
		});

		await expect(idleEndAsync(run)).resolves.toBe("shutdown");
	});

	it("should start the time again on each compile start", async ({ expect }) => {
		expect.assertions(2);

		const { run, watched } = await startUpAsync(TIMEOUT);
		let edits = 0;
		await keepActiveAsync({ expect }, run, () => {
			edits += 1;
			writeFileSync(watched, `export const edit = ${edits};\n`);
		});

		await expect(idleEndAsync(run)).resolves.toBe("shutdown");
	});

	it(
		"should start the time again on each Studio save, then close Studio",
		{ timeout: 40_000 },
		async ({ expect }) => {
			expect.assertions(4);

			const project = await makeProjectAsync({
				session: { idleTimeout: TIMEOUT },
				studio: { autoRecovery: "keep" },
			});
			const place = path.join(project.project, "game.rbxl");
			const run = launchUnowned(project, START_STUDIO, studioEnvironment(project));
			await waitForStatusAsync(
				project,
				run,
				({ services }) => services.studio.status === "open",
			);
			const opened = Date.now();
			await keepActiveAsync({ expect }, run, () => {
				const now = new Date();
				utimesSync(place, now, now);
			});
			const reason = await idleEndAsync(run);

			expect(reason).toBe("shutdown");
			expect(Date.now() - opened).toBeGreaterThan(ACTIVE_MS + TIMEOUT_MS - ACTIVITY_EVERY_MS);
			expect(existsSync(`${place}.lock`)).toBeFalse();
		},
	);

	it("should stop the Rojo of a found Studio, let it go open, and end an up session", async ({
		expect,
	}) => {
		expect.assertions(6);

		const project = await makeProjectAsync({ session: { idleTimeout: SHORT_TIMEOUT } });
		const environment: Record<string, string> = {
			...studioEnvironment(project),
			FIXTURE_LOG: project.log,
		};
		const place = path.join(project.project, "game.rbxl");
		writeFileSync(place, environment["FIXTURE_PLACE_CONTENT"]!);
		const studio = pidOf(await openStudioStandInAsync(place, environment));
		const originalLock = readFileSync(`${place}.lock`, "utf8");
		const run = launchUnowned(project, START_STUDIO, environment);

		// Retained events survive idle exit; status requests are activity.
		await expect(idleEndAsync(run)).resolves.toBe("shutdown");

		const info = run.events.filter((event) => event.type === "info");

		expect(info[0]!.message).toStartWith("Rojo serves ");
		expect(info.slice(1)).toStrictEqual([
			{
				message: `No activity for ${SHORT_TIMEOUT} min: stopped rojo.`,
				type: "info",
			},
		]);

		const workers = readWorkerLog(project.log);
		const rojo = workers
			.filter(({ role }) => role === "rojo")
			.filter(({ args }) => args.includes("serve"));

		expect(rojo.map(({ pid }) => isProcessAlive(pid))).toStrictEqual([false]);
		expect(workers.filter(({ role }) => role === "studio").map(({ pid }) => pid)).toStrictEqual(
			[studio],
		);
		expect({
			lock: readFileSync(`${place}.lock`, "utf8"),
			running: isProcessAlive(studio),
		}).toStrictEqual({ lock: originalLock, running: true });
	});

	it("should never stop a part a start owns, nor end its session", async ({ expect }) => {
		expect.assertions(3);

		const project = await makeProjectAsync({
			session: { idleTimeout: SHORT_TIMEOUT },
			studio: { autoRecovery: "keep" },
		});
		const run = launch(project, START_STUDIO, studioEnvironment(project));
		let isSettled = false;
		void run.settled.finally(() => {
			isSettled = true;
		});
		const session = await waitForSessionAsync(project);
		const target = { endpoint: session.identity.endpoint, token: session.token };
		await callSessionAsync(realTransport(), target, "addParts", {
			params: { parts: ["compiler"] },
			responseTimeoutMs: SETTLE_MS,
		});
		// Status requests are activity: wait for the stop's report instead.
		await waitForAsync(() => run.events.find(isIdleStop));
		// Longer than two more timeouts.
		await sleep(3000);
		const idle = await waitForStatusAsync(project, run, () => true);
		const rojo = workersOf(project, session.identity.sessionId)
			.filter(({ role }) => role === "rojo")
			.find(({ args }) => args.includes("serve"));

		expect(idle.services).toMatchObject({
			compiler: { owner: null, status: "off" },
			rojo: { owner: "start", status: "ready" },
			studio: { owner: "start", status: "open" },
		});
		expect(run.events).toContainEqual({
			message: `No activity for ${SHORT_TIMEOUT} min: stopped compiler.`,
			type: "info",
		});
		expect({ running: isProcessAlive(rojo!.pid), settled: isSettled }).toStrictEqual({
			running: true,
			settled: false,
		});
	});
});

describe("idle status observation", () => {
	it("should retain the IPC failure and live supervisor evidence when status gets no answer", async ({
		expect,
		onTestFinished,
	}) => {
		expect.assertions(2);

		const project = await makeProjectAsync();
		const run = launch(project, COMPILER_ONLY, { RBX_FORGE_TEST_PAUSE: "block" });
		await waitForStatusAsync(
			project,
			run,
			({ services }) => services.compiler.status === "ready",
		);
		const identity = currentIdentity(project);
		const pin = native.pinProcess(identity.pid);
		assert(pin !== null && pin.startTime === identity.processStartTime);
		onTestFinished(() => {
			pin.kill();
		});
		mkdirSync(project.pauses, { recursive: true });
		writeFileSync(path.join(project.pauses, "block.request"), "");
		await waitForFileAsync(path.join(project.pauses, "block.blocked"));

		const failure: unknown = await waitForStatusAsync(project, run, () => true).catch(
			(err: unknown) => err,
		);
		assert(failure instanceof Error);

		expect(failure).toMatchObject({
			cause: { code: "supervisor_unresponsive" },
		});
		expect(
			JSON.parse(failure.message.slice("Idle status observation failed: ".length)),
		).toMatchObject({
			identity,
			outcome: "pending",
			savedStatus: { phase: "ready", services: { compiler: { status: "ready" } } },
			supervisorAlive: true,
		});
	});
});
