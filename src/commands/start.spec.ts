import path from "node:path";
import { assert, describe, expect, it, vi } from "vitest";

import { createMemoryTransport } from "../../test/helpers/fake-ipc.ts";
import type { MemoryTransport } from "../../test/helpers/fake-ipc.ts";
import { createFakeReaper, createFakeSignals } from "../../test/helpers/fake-reaper.ts";
import type { FakeSession } from "../../test/helpers/fake-session.ts";
import { makeStatus, serveFakeSessionAsync } from "../../test/helpers/fake-session.ts";
import type { MemoryFileSystem } from "../../test/helpers/seams.ts";
import {
	createCommandContext,
	createMemoryFileSystem,
	createRecordingReporter,
	createTestSeams,
	PROJECT,
} from "../../test/helpers/seams.ts";
import { ForgeError } from "../errors.ts";
import type { IpcHandler } from "../ipc/server.ts";
import type { CommandResult } from "../seams/reporter.ts";
import type { SupervisorLaunch, SupervisorLauncher } from "../supervisor/launcher.ts";
import { JOIN_SILENCE_MS, runStartAsync, START_FLAGS } from "./start.ts";

/**
 * Run `start` with no session running, once it launched its supervisor.
 *
 * @param flags - The parsed flags.
 * @returns The run.
 */
async function startWithAsync(flags: Record<string, boolean> = {}) {
	const signals = createFakeSignals();
	const reporter = createRecordingReporter();
	const result = Promise.withResolvers<CommandResult>();
	const stop = vi.fn<(signal: NodeJS.Signals) => void>();
	const launches: Array<SupervisorLaunch> = [];
	const supervisor = vi.fn<SupervisorLauncher>((launch) => {
		launches.push(launch);
		return { result: result.promise, stop };
	});
	const running = runStartAsync(
		createCommandContext({
			env: { PATH: "/bin" },
			reporter,
			seams: createTestSeams({ signals: signals.signals, supervisor }),
		}),
		{ config: { rojoPort: 5000 }, flags },
	);
	await vi.waitFor(() => {
		assert(launches.length === 1, "start launched its supervisor");
	});
	return { launches, reporter, result, running, signals, stop };
}

describe(runStartAsync, () => {
	it("should read --syncback into syncback.runOnStart", () => {
		expect.assertions(1);

		expect(START_FLAGS).toContainEqual(
			expect.objectContaining({ name: "syncback", config: "syncback.runOnStart" }),
		);
	});

	it("should launch the supervisor with the project, environment, and request", async () => {
		expect.assertions(2);

		const plain = await startWithAsync();
		const bare = await startWithAsync({ compiler: false, open: false });

		expect(plain.launches).toMatchObject([
			{
				cwd: PROJECT,
				env: { PATH: "/bin" },
				request: { compiler: true, config: { rojoPort: 5000 }, open: true, rojo: true },
			},
		]);
		expect(bare.launches[0]!.request).toMatchObject({ compiler: false, open: false });
	});

	it("should ask for forced cleanup of an earlier session only with --force", async () => {
		expect.assertions(2);

		const forced = await startWithAsync({ force: true });
		const plain = await startWithAsync({ force: false });

		expect(forced.launches[0]!.request).toStrictEqual({
			compiler: true,
			config: { rojoPort: 5000 },
			force: true,
			open: true,
			rojo: true,
		});
		expect(plain.launches[0]!.request).toStrictEqual({
			compiler: true,
			config: { rojoPort: 5000 },
			open: true,
			rojo: true,
		});
	});

	it("should report the supervisor's events and return its result", async () => {
		expect.assertions(2);

		const { launches, reporter, result, running } = await startWithAsync();
		launches[0]!.onEvent({ message: "ready", type: "info" });
		result.resolve({ data: { reason: "SIGINT" }, summary: "Stopped." });

		await expect(running).resolves.toStrictEqual({
			data: { reason: "SIGINT" },
			summary: "Stopped.",
		});
		expect(reporter.events).toStrictEqual([{ message: "ready", type: "info" }]);
	});

	it("should pass stop signals on until the supervisor ends", async () => {
		expect.assertions(2);

		const { result, running, signals, stop } = await startWithAsync();
		signals.fire("SIGINT");
		result.reject(new ForgeError("port_in_use", "busy"));

		await expect(running).rejects.toMatchObject({ code: "port_in_use" });
		expect([stop.mock.calls, signals.listeners()]).toStrictEqual([[["SIGINT"]], 0]);
	});
});

const JOINED = { added: ["studio", "rojo"], sessionId: "s1", taken: ["compiler"] };
const RELEASED = {
	ending: false,
	released: ["compiler"],
	sessionId: "s1",
	stopped: ["rojo"],
	studioLeft: true,
};

interface JoinRun {
	ipc: MemoryTransport;
	memory: MemoryFileSystem;
	reporter: ReturnType<typeof createRecordingReporter>;
	running: Promise<CommandResult>;
	signals: ReturnType<typeof createFakeSignals>;
	supervisor: ReturnType<typeof vi.fn<SupervisorLauncher>>;
}

/**
 * Run `start` next to a fake session that the test set up.
 *
 * @param flags - The parsed flags.
 * @param setup - Serves the session first, or from the supervisor.
 * @returns The run.
 */
async function joinWithAsync(
	flags: Record<string, boolean | string>,
	setup: {
		serve?: (memory: MemoryFileSystem, ipc: MemoryTransport) => Promise<unknown>;
		supervisor?: SupervisorLauncher;
	},
): Promise<JoinRun> {
	const memory = createMemoryFileSystem();
	const ipc = createMemoryTransport();
	await setup.serve?.(memory, ipc);
	const signals = createFakeSignals();
	const reporter = createRecordingReporter();
	const supervisor = vi.fn<SupervisorLauncher>(setup.supervisor);
	let now = 0;
	const running = runStartAsync(
		createCommandContext({
			reporter,
			seams: createTestSeams({
				clock: {
					now: () => now,
					sleep: async () => {
						now += 1000;
					},
				},
				fileSystem: memory.fileSystem,
				ipc,
				reaper: createFakeReaper().launch,
				signals: signals.signals,
				supervisor,
			}),
		}),
		{ config: {}, flags },
	);
	return { ipc, memory, reporter, running, signals, supervisor };
}

/**
 * Serve a fake session that answers the join and the release.
 *
 * @param change - Changes the session, such as its answers.
 * @returns What serves it.
 */
function serving(
	change: (session: FakeSession) => void = () => {},
): (memory: MemoryFileSystem, ipc: MemoryTransport) => Promise<FakeSession> {
	return async (memory, ipc) => {
		const session = await serveFakeSessionAsync(memory, ipc, makeStatus());
		vi.spyOn(session, "join").mockResolvedValue(JOINED);
		vi.spyOn(session, "leave").mockResolvedValue(RELEASED);
		change(session);
		return session;
	};
}

async function joinedAsync(run: JoinRun): Promise<void> {
	await vi.waitFor(() => {
		assert(run.reporter.events.length > 0, "start joined");
	});
}

describe("runStartAsync next to a running session", () => {
	it("should join it as its owner, and let go on a stop signal", async () => {
		expect.assertions(4);

		let session: FakeSession | undefined;
		const run = await joinWithAsync(
			{ "studio-path": "Studio.exe" },
			{
				serve: serving((served) => {
					session = served;
				}),
			},
		);
		await joinedAsync(run);
		run.signals.fire("SIGINT");

		await expect(run.running).resolves.toStrictEqual({
			data: RELEASED,
			summary:
				"Let go of session s1: stopped Rojo; left Studio open; the compiler runs on with no owner.",
		});
		expect(run.reporter.events).toStrictEqual([
			{
				message:
					"Joined session s1: took the compiler; started Studio and Rojo. Press Ctrl+C to stop.",
				type: "info",
			},
		]);
		expect(session!.join).toHaveBeenCalledExactlyOnceWith({
			parts: ["compiler", "studio"],
			studioPath: path.resolve(PROJECT, "Studio.exe"),
		});
		expect([run.supervisor.mock.calls, run.signals.listeners()]).toStrictEqual([[], 0]);
	});

	it("should ask for no part with --no-compiler and --no-open", async () => {
		expect.assertions(2);

		let session: FakeSession | undefined;
		const run = await joinWithAsync(
			{ compiler: false, open: false },
			{
				serve: serving((served) => {
					session = served;
					vi.spyOn(served, "join").mockResolvedValue({
						added: [],
						sessionId: "s1",
						taken: [],
					});
				}),
			},
		);
		await joinedAsync(run);
		run.signals.fire("SIGINT");
		await run.running;

		expect(session!.join).toHaveBeenCalledExactlyOnceWith({ parts: [] });
		expect(run.reporter.events).toStrictEqual([
			{ message: "Joined session s1: it has no part. Press Ctrl+C to stop.", type: "info" },
		]);
	});

	it.for([
		["closes the connection", async (session: FakeSession) => session.stop()],
		[
			"is stopping when it lets go",
			async (session: FakeSession) => {
				vi.spyOn(session, "leave").mockRejectedValue(
					new ForgeError("not_running", "stopping"),
				);
			},
		],
	] as const)("should say the session ended when it %s", async ([, end]) => {
		expect.assertions(1);

		let session: FakeSession | undefined;
		const run = await joinWithAsync(
			{},
			{
				serve: serving((served) => {
					session = served;
				}),
			},
		);
		await joinedAsync(run);
		await end(session!);
		run.signals.fire("SIGINT");

		await expect(run.running).resolves.toStrictEqual({
			data: { ending: true, sessionId: "s1" },
			summary: "Session s1 ended.",
		});
	});

	it("should fail with the release's other failures", async () => {
		expect.assertions(1);

		const run = await joinWithAsync(
			{},
			{
				serve: serving((session) => {
					vi.spyOn(session, "leave").mockRejectedValue(
						new ForgeError("hook_failed", "bad"),
					);
				}),
			},
		);
		await joinedAsync(run);
		run.signals.fire("SIGINT");

		await expect(run.running).rejects.toMatchObject({ code: "hook_failed" });
	});

	it("should fail with the join's failure", async () => {
		expect.assertions(1);

		const run = await joinWithAsync(
			{},
			{
				serve: serving((session) => {
					vi.spyOn(session, "join").mockRejectedValue(
						new ForgeError("session_running", "owned"),
					);
				}),
			},
		);

		await expect(run.running).rejects.toMatchObject({ code: "session_running" });
	});

	it("should give up on a join on a stop signal", async () => {
		expect.assertions(1);

		const joining = Promise.withResolvers<Record<string, unknown>>();
		const join = vi.fn<IpcHandler>(async () => joining.promise);
		const run = await joinWithAsync(
			{},
			{
				serve: serving((served) => {
					vi.spyOn(served, "join").mockImplementation(join);
				}),
			},
		);
		await vi.waitFor(() => {
			assert(join.mock.calls.length === 1, "start waits for the join");
		});
		run.signals.fire("SIGINT");
		const given = await run.running;
		joining.resolve(JOINED);

		expect(given).toStrictEqual({
			data: { sessionId: "s1" },
			summary: "Stopped before it joined session s1; the session let go of what it took.",
		});
	});

	it("should join the session that won the race to start", async () => {
		expect.assertions(1);

		let ipcOf: MemoryTransport | undefined;
		let memoryOf: MemoryFileSystem | undefined;
		const run = await joinWithAsync(
			{},
			{
				serve: async (memory, ipc) => {
					ipcOf = ipc;
					memoryOf = memory;
				},
				supervisor: () => {
					const lost = (async () => {
						await serving()(memoryOf!, ipcOf!);
						throw new ForgeError("session_running", "running");
					})();
					return { result: lost, stop: vi.fn<(signal: NodeJS.Signals) => void>() };
				},
			},
		);
		await joinedAsync(run);
		run.signals.fire("SIGINT");

		await expect(run.running).resolves.toMatchObject({ data: { sessionId: "s1" } });
	});

	it("should fail with session_running when the session that holds the project never answers", async () => {
		expect.assertions(2);

		const run = await joinWithAsync(
			{},
			{
				supervisor: () => {
					return {
						result: Promise.reject(new ForgeError("session_running", "running")),
						stop: vi.fn<(signal: NodeJS.Signals) => void>(),
					};
				},
			},
		);

		await expect(run.running).rejects.toMatchObject({
			code: "session_running",
			hint: 'Check "forge status", or stop it with "forge down".',
			message: "A session holds this project, but it does not answer.",
		});
		expect(JOIN_SILENCE_MS).toBe(30_000);
	});
});
