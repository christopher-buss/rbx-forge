import path from "node:path";
import { assert, describe, expect, it, vi } from "vitest";

import { createMemoryTransport } from "../../test/helpers/fake-ipc.ts";
import { makeStatus, serveFakeSessionAsync } from "../../test/helpers/fake-session.ts";
import { createFakeNative } from "../../test/helpers/native.ts";
import {
	createCommandContext,
	createMemoryFileSystem,
	createRecordingReporter,
	createTestSeams,
	PROJECT,
} from "../../test/helpers/seams.ts";
import type { Clock } from "../seams/clock.ts";
import type { SessionRequest, SupervisorMessage } from "../supervisor/channel.ts";
import { encodeMessage } from "../supervisor/channel.ts";
import type { DetachedLaunch, DetachedLauncher } from "../supervisor/detached-launcher.ts";
import type { CommandInput } from "./context.ts";
import { JOIN_SILENCE_MS, runUpAsync, UP_POLL_MS, UP_TIMEOUT_MS } from "./up.ts";

const INPUT: CommandInput = { config: {}, flags: {} };
const LAUNCH_DIRECTORY = path.join(PROJECT, ".forge", "launch");

/** What each `sleep` of `up` runs, in order; later sleeps run nothing. */
type Tick = () => Promise<void> | void;

interface UpRun {
	detachedSupervisor: ReturnType<typeof vi.fn<DetachedLauncher>>;
	ipc: ReturnType<typeof createMemoryTransport>;
	memory: ReturnType<typeof createMemoryFileSystem>;
	native: ReturnType<typeof createFakeNative>;
	now: () => number;
	reporter: ReturnType<typeof createRecordingReporter>;
	ticks: Array<Tick>;
	writeReport: (request: SessionRequest, messages: ReadonlyArray<SupervisorMessage>) => void;
}

function makeUp(launch: (request: SessionRequest, up: UpRun) => number = () => 700) {
	const memory = createMemoryFileSystem();
	const ipc = createMemoryTransport();
	const reporter = createRecordingReporter();
	const native = createFakeNative({ 700: { alive: true, executablePath: "/node" } });
	const ticks: Array<Tick> = [];
	let now = 0;
	const clock: Clock = {
		now: () => now,
		sleep: async (ms) => {
			now += ms;
			await ticks.shift()?.();
		},
	};
	const up: UpRun = {
		detachedSupervisor: vi.fn<DetachedLauncher>((launched: DetachedLaunch) => {
			return launch(launched.request, up);
		}),
		ipc,
		memory,
		native,
		now: () => now,
		reporter,
		ticks,
		writeReport: (request, messages) => {
			assert(request.detached !== undefined, "a detached request");
			memory.fileSystem.writeFileSync(
				request.detached.report,
				messages.map(encodeMessage).join(""),
				{ flag: "a" },
			);
		},
	};
	const context = createCommandContext({
		reporter,
		seams: createTestSeams({
			clock,
			detachedSupervisor: up.detachedSupervisor,
			fileSystem: memory.fileSystem,
			ipc,
			native: () => native.addon,
			randomId: () => "l1",
		}),
	});
	return { run: async () => runUpAsync(context, INPUT), up };
}

function launchFiles(up: UpRun): Array<string> {
	return Object.keys(up.memory.files()).filter((file) => file.startsWith(".forge/launch/"));
}

describe(runUpAsync, () => {
	it("should start a detached session, relay its events, and return once it is ready", async () => {
		expect.assertions(4);

		const { run, up } = makeUp((request, self) => {
			self.writeReport(request, [
				{ event: { message: "compiling", type: "info" }, type: "event" },
			]);
			self.ticks.push(async () => {
				await serveFakeSessionAsync(self.memory, self.ipc, makeStatus({ pid: 700 }));
			});
			return 700;
		});

		await expect(run()).resolves.toStrictEqual({
			data: { ...makeStatus({ pid: 700 }), started: true },
			summary: "Started session s1: Rojo serves on port 34872.",
		});
		expect(up.detachedSupervisor).toHaveBeenCalledExactlyOnceWith({
			cwd: PROJECT,
			env: {},
			request: {
				compiler: true,
				config: {},
				detached: { report: path.join(LAUNCH_DIRECTORY, "l1.ndjson") },
				open: true,
			},
		});
		expect(up.reporter.events).toStrictEqual([{ message: "compiling", type: "info" }]);
		expect(launchFiles(up)).toStrictEqual([]);
	});

	it("should relay an event the supervisor wrote in two parts once", async () => {
		expect.assertions(1);

		const { run, up } = makeUp((request, self) => {
			const line = encodeMessage({ event: { message: "half", type: "info" }, type: "event" });
			const { report } = request.detached!;
			self.memory.fileSystem.mkdirSync(LAUNCH_DIRECTORY, { recursive: true });
			self.memory.fileSystem.writeFileSync(report, line.slice(0, 10));
			self.ticks.push(
				() => {
					self.memory.fileSystem.writeFileSync(report, line.slice(10), { flag: "a" });
				},
				async () => {
					await serveFakeSessionAsync(self.memory, self.ipc, makeStatus({ pid: 700 }));
				},
			);
			return 700;
		});
		await run();

		expect(up.reporter.events).toStrictEqual([{ message: "half", type: "info" }]);
	});

	it("should pass --no-compiler, --no-open, and the flags' config on", async () => {
		expect.assertions(1);

		const { up } = makeUp((_request, self) => {
			self.ticks.push(async () => {
				await serveFakeSessionAsync(self.memory, self.ipc, makeStatus({ pid: 700 }));
			});
			return 700;
		});
		const context = createCommandContext({
			seams: createTestSeams({
				clock: { now: up.now, sleep: async () => up.ticks.shift()!() },
				detachedSupervisor: up.detachedSupervisor,
				fileSystem: up.memory.fileSystem,
				ipc: up.ipc,
				native: () => up.native.addon,
				randomId: () => "l1",
			}),
		});
		await runUpAsync(context, {
			config: { syncback: { runOnStart: true } },
			flags: { compiler: false, open: false },
		});

		expect(up.detachedSupervisor.mock.calls[0]![0].request).toMatchObject({
			compiler: false,
			config: { syncback: { runOnStart: true } },
			open: false,
		});
	});

	it("should report a running session instead of starting a second one", async () => {
		expect.assertions(2);

		const { run, up } = makeUp();
		await serveFakeSessionAsync(up.memory, up.ipc);

		await expect(run()).resolves.toStrictEqual({
			data: { ...makeStatus(), started: false },
			summary: "Found session s1: Rojo serves on port 34872.",
		});
		expect(up.detachedSupervisor).not.toHaveBeenCalled();
	});

	it("should wait for a session that is starting instead of starting one", async () => {
		expect.assertions(3);

		const { run, up } = makeUp();
		const session = await serveFakeSessionAsync(
			up.memory,
			up.ipc,
			makeStatus({ phase: "starting" }),
		);
		up.ticks.push(() => {
			session.status = makeStatus();
		});

		await expect(run()).resolves.toMatchObject({ data: { phase: "ready", started: false } });
		expect(up.detachedSupervisor).not.toHaveBeenCalled();
		expect(up.now()).toBe(UP_POLL_MS);
	});

	it("should fail with the session's startup failure and remove its report", async () => {
		expect.assertions(2);

		const { run, up } = makeUp((request, self) => {
			self.writeReport(request, [
				{
					error: { code: "port_in_use", hint: "h", message: "Rojo port 4000 is in use." },
					ok: false,
					type: "result",
				},
			]);
			return 700;
		});

		await expect(run()).rejects.toMatchObject({
			code: "port_in_use",
			message: "Rojo port 4000 is in use.",
		});
		expect(launchFiles(up)).toStrictEqual([]);
	});

	it("should wait for the other session when its supervisor lost the race", async () => {
		expect.assertions(2);

		const { run, up } = makeUp((request, self) => {
			self.writeReport(request, [
				{ error: { code: "session_running", message: "m" }, ok: false, type: "result" },
			]);
			self.ticks.push(async () => {
				await serveFakeSessionAsync(self.memory, self.ipc, makeStatus({ pid: 800 }));
			});
			return 700;
		});

		await expect(run()).resolves.toMatchObject({ data: { pid: 800, started: false } });
		expect(launchFiles(up)).toStrictEqual([]);
	});

	it("should fail with not_running when the session ended before it was ready", async () => {
		expect.assertions(1);

		const { run } = makeUp((request, self) => {
			self.writeReport(request, [
				{ data: {}, ok: true, summary: "Studio closed the place.", type: "result" },
			]);
			return 700;
		});

		await expect(run()).rejects.toMatchObject({
			code: "not_running",
			message: "The session ended before it was ready: Studio closed the place.",
		});
	});

	it("should fail with internal_error when the supervisor died without a result", async () => {
		expect.assertions(2);

		const { run, up } = makeUp((request, self) => {
			// Half a line: the supervisor died while writing.
			self.memory.fileSystem.mkdirSync(LAUNCH_DIRECTORY, { recursive: true });
			self.memory.fileSystem.writeFileSync(request.detached!.report, '{"type":');
			return 701;
		});

		await expect(run()).rejects.toMatchObject({
			code: "internal_error",
			hint: `Its output is in ${path.join(PROJECT, ".forge", "logs", "supervisor.log")}.`,
			message: "The session's supervisor exited without a result.",
		});
		expect(launchFiles(up)).toStrictEqual([]);
	});

	it("should fail with supervisor_unresponsive when the session is not ready in time", async () => {
		expect.assertions(2);

		const { run, up } = makeUp();

		await expect(run()).rejects.toMatchObject({
			code: "supervisor_unresponsive",
			hint: 'Check "forge logs start" and "forge status", or stop the session and try again.',
			message: `The session was not ready within ${UP_TIMEOUT_MS / 1000} s.`,
		});
		expect(up.now()).toBe(UP_TIMEOUT_MS);
	});

	it("should start a session once when the one it waits for stays silent, then give up", async () => {
		expect.assertions(3);

		const { run, up } = makeUp((request, self) => {
			self.writeReport(request, [
				{ error: { code: "session_running", message: "m" }, ok: false, type: "result" },
			]);
			return 700;
		});
		const session = await serveFakeSessionAsync(
			up.memory,
			up.ipc,
			makeStatus({ phase: "starting" }),
		);
		up.ticks.push(session.stop);

		await expect(run()).rejects.toMatchObject({
			code: "supervisor_unresponsive",
			message: "The session that is starting does not answer.",
		});
		expect(up.detachedSupervisor).toHaveBeenCalledOnce();
		expect(up.now()).toBe(2 * JOIN_SILENCE_MS + UP_POLL_MS);
	});
});
