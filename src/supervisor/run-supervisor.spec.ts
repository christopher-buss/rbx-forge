import path from "node:path";
import { assert, describe, expect, it, vi } from "vitest";

import { createMemoryTransport } from "../../test/helpers/fake-ipc.ts";
import type { MemoryTransport } from "../../test/helpers/fake-ipc.ts";
import { createFakeReaper, createFakeSignals } from "../../test/helpers/fake-reaper.ts";
import type { FakeReaper, FakeReaperOptions, FakeSignals } from "../../test/helpers/fake-reaper.ts";
import { createManualClock } from "../../test/helpers/manual-clock.ts";
import type { ManualClock } from "../../test/helpers/manual-clock.ts";
import { createFakeNative } from "../../test/helpers/native.ts";
import type { FakeNative } from "../../test/helpers/native.ts";
import {
	createCommandContext,
	createMemoryFileSystem,
	createRecordingReporter,
	createTestSeams,
	PROJECT,
} from "../../test/helpers/seams.ts";
import type { MemoryFileSystem, RecordingReporter } from "../../test/helpers/seams.ts";
import type { FlagValues } from "../cli/flags.ts";
import { ForgeError } from "../errors.ts";
import { callSessionAsync } from "../ipc/client.ts";
import type { WorkerReport, WorkerSpec } from "../reaper/protocol.ts";
import type { ReaperEnd } from "../reaper/reaper-client.ts";
import type { ConfigLoader } from "../seams/config-loader.ts";
import type { Network } from "../seams/network.ts";
import type { CommandResult } from "../seams/reporter.ts";
import type { Pause, PausePoint } from "../session/pause.ts";
import { neverPauseAsync } from "../session/pause.ts";
import { FILE_POLL_MS, OUTPUT_POLL_MS, ROJO_LISTEN_BOUND_MS } from "../session/session-body.ts";
import type { StopSource } from "../session/stop-source.ts";
import { createStopSource } from "../session/stop-source.ts";
import type { StudioLauncher } from "../studio/launcher.ts";
import type { SessionRequest } from "./channel.ts";
import { endpointFor } from "./endpoint.ts";
import { runSupervisorAsync } from "./run-supervisor.ts";
import type { IdentityRecord } from "./session-files.ts";

const TOOLS = path.join(PROJECT, "tools");
const ROJO_ONLY: FlagValues = { compiler: false, open: false };
const OK: WorkerReport = { exitCode: 0, forced: false, incomplete: false, signal: null };
const EXITED: WorkerReport = { ...OK, exitCode: 3 };
const PLACE = path.join(PROJECT, "game.rbxl");
const LOCK = `${PLACE}.lock`;
const SESSION = path.join(PROJECT, ".forge", "sessions", "session-1");
const SERVICES = new Set(["compiler", "rojo"]);
const SINGLETON = path.join(PROJECT, ".forge", "supervisor.lock");
const OLD_LEASE = path.join(PROJECT, ".forge", "sessions", "old", "workers.lock");
/** The identity record of every run, but its endpoint. */
const IDENTITY: Pick<
	IdentityRecord,
	"pid" | "processStartTime" | "sessionId" | "startedAt" | "version"
> = {
	pid: 4242,
	processStartTime: "4242",
	sessionId: "session-1",
	startedAt: "2026-01-01T00:00:00.000Z",
	version: "9.9.9",
};
const TOOL_FILES = { "tools/rbxtsc": "", "tools/rojo": "" };
const WITH_OLD = { ...TOOL_FILES, ".forge/sessions/old/supervisor.id": "{}" };

interface StartSetup {
	/** The config file's content besides `projectType`. */
	file?: object;
	files?: Record<string, string>;
	flags?: FlagValues;
	/** Makes the control endpoint's transport; in memory by default. */
	ipc?: () => MemoryTransport;
	/** Whether Rojo listens on its port, each time the session looks. */
	isListening?: Network["isListeningAsync"];
	/** Whether the Rojo port is free. */
	isPortFree?: boolean;
	/** How a one-shot run ends; services never end on their own. */
	oneShot?: (worker: WorkerSpec) => undefined | WorkerReport;
	/** Gets the supervisor's ready call. */
	onReady?: () => void;
	/** Makes the test pause points from the run's stop source. */
	pause?: (stop: StopSource) => Pause;
	/** The host OS; Linux by default. */
	platform?: NodeJS.Platform;
	projectType?: "luau" | "rbxts";
	reaper?: FakeReaperOptions;
	/** The addon's private file writer (Windows). */
	writePrivateFile?: (file: string, text: string) => void;
}

interface StartRun {
	clock: ManualClock;
	fake: FakeReaper;
	ipc: MemoryTransport;
	isListeningAsync: ReturnType<typeof vi.fn<Network["isListeningAsync"]>>;
	isPortFreeAsync: ReturnType<typeof vi.fn<Network["isPortFreeAsync"]>>;
	memory: MemoryFileSystem;
	native: FakeNative;
	reporter: RecordingReporter;
	result: Promise<CommandResult>;
	signals: FakeSignals;
	stop: StopSource;
	studioLauncher: ReturnType<typeof vi.fn<StudioLauncher>>;
}

const SYNCBACK: StartSetup = {
	file: { hooks: { syncback: { post: ["lint"] } } },
	flags: { compiler: false, open: false, syncback: true },
};

function succeedOneShots(worker: WorkerSpec): undefined | WorkerReport {
	return SERVICES.has(worker.id) ? undefined : OK;
}

/**
 * One-shot runs succeed, except the named ones: they end with the given
 * report, or stay running (`hold`) until the test ends them.
 *
 * @param overrides - Reports by worker id.
 * @returns The fake reaper's `autoExit`.
 */
function oneShotsWith(
	overrides: Readonly<Record<string, "hold" | WorkerReport>>,
): (worker: WorkerSpec) => undefined | WorkerReport {
	return (worker) => {
		const override = overrides[worker.id];
		if (override === "hold") {
			return;
		}

		return override ?? succeedOneShots(worker);
	};
}

/**
 * Call `action` when the worker with this id is spawned.
 *
 * @param id - The worker id.
 * @param action - What to do, such as send a stop signal.
 * @returns The fake reaper's `onSpawn`.
 */
function onSpawnOf(id: string, action: () => void): (worker: WorkerSpec) => void {
	return (worker) => {
		if (worker.id === id) {
			action();
		}
	};
}

/**
 * The session request `forge start` sends for these flags.
 *
 * @param flags - The parsed flags.
 * @returns The request; `--syncback` sets `syncback.runOnStart`.
 */
function requestFor(flags: FlagValues): SessionRequest {
	return {
		compiler: flags["compiler"] !== false,
		config: flags["syncback"] === true ? { syncback: { runOnStart: true } } : {},
		open: flags["open"] !== false,
		...(flags["force"] === true ? { force: true } : {}),
	};
}

function startCommand({
	file = {},
	files = TOOL_FILES,
	flags = ROJO_ONLY,
	ipc: makeTransport = createMemoryTransport,
	isListening = async () => true,
	isPortFree = true,
	oneShot = succeedOneShots,
	onReady,
	pause = () => neverPauseAsync,
	platform = "linux",
	projectType = "luau",
	reaper = {},
	writePrivateFile,
}: StartSetup = {}): StartRun {
	const memory = createMemoryFileSystem(files);
	const clock = createManualClock(Date.UTC(2026, 0, 1));
	const fake = createFakeReaper({ autoExit: oneShot, ...reaper });
	const signals = createFakeSignals();
	const stop = createStopSource();
	signals.onStop(stop.request);
	const ipc = makeTransport();
	const seams = createTestSeams();
	const native = createFakeNative({ 4242: { alive: true, executablePath: "/node" } });
	const reporter = createRecordingReporter();
	const isPortFreeAsync = vi.fn<Network["isPortFreeAsync"]>().mockResolvedValue(isPortFree);
	const isListeningAsync = vi.fn<Network["isListeningAsync"]>(isListening);
	const studioLauncher = vi.fn<StudioLauncher>().mockResolvedValue({ type: "launched" });
	const configLoader = vi.fn<ConfigLoader>().mockResolvedValue({
		path: path.join(PROJECT, "rbx-forge.config.ts"),
		value: { projectType, rojoPort: 4000, ...file },
	});
	const context = createCommandContext({
		env: { PATH: TOOLS },
		reporter,
		seams: createTestSeams({
			clock: clock.clock,
			configLoader,
			fileSystem: memory.fileSystem,
			host: { ...seams.host, platform },
			ipc,
			native: () => {
				return {
					...native.addon,
					...(writePrivateFile === undefined ? {} : { writePrivateFile }),
				};
			},
			network: { isListeningAsync, isPortFreeAsync },
			randomId: () => "session-1",
			reaper: fake.launch,
			studioLauncher,
		}),
	});

	return {
		clock,
		fake,
		ipc,
		isListeningAsync,
		isPortFreeAsync,
		memory,
		native,
		reporter,
		result: runSupervisorAsync(context, requestFor(flags), {
			onReady,
			pause: pause(stop),
			stop,
			version: "9.9.9",
		}),
		signals,
		stop,
		studioLauncher,
	};
}

/**
 * A pause that sends SIGTERM at one point.
 *
 * @param point - Where to stop.
 * @param stop - The run's stop source.
 * @returns The pause.
 */
function stopAt(point: PausePoint, stop: StopSource): Pause {
	return async (at) => {
		if (at === point) {
			stop.request({ signal: "SIGTERM", type: "signal" });
		}
	};
}

/**
 * A pause that calls `note`, then sends SIGTERM, at one point.
 *
 * @param point - Where to stop.
 * @param stop - The run's stop source.
 * @param note - Reads what the test checks there.
 * @returns The pause.
 */
function noteAndStopAt(point: PausePoint, stop: StopSource, note: () => void): Pause {
	return async (at, signal) => {
		if (at === point) {
			note();
		}

		await stopAt(point, stop)(at, signal);
	};
}

/**
 * The identity record in a copy of the project's files.
 *
 * @param files - The files, as `memory.files()` returns them.
 * @returns The parsed record.
 */
function identityIn(files: Record<string, null | string>): IdentityRecord {
	const text = files[".forge/sessions/session-1/supervisor.id"];
	assert(typeof text === "string", "expected an identity record");
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- createSession writes this shape
	return JSON.parse(text) as unknown as IdentityRecord;
}

/**
 * The session's `state.json` now.
 *
 * @param run - The session.
 * @returns Its parsed content.
 */
function stateOf(run: StartRun): unknown {
	const text = run.memory.files()[".forge/sessions/session-1/state.json"];
	assert(typeof text === "string", "expected state.json");
	return JSON.parse(text);
}

async function flushAsync(): Promise<void> {
	await new Promise((resolve) => {
		setImmediate(resolve);
	});
}

/**
 * Let time pass in steps, so each poll runs and what it started settles.
 *
 * @param run - The session.
 * @param ms - How long.
 */
async function passAsync(run: StartRun, ms: number): Promise<void> {
	for (let passed = 0; passed < ms; passed += OUTPUT_POLL_MS) {
		run.clock.advance(OUTPUT_POLL_MS);
		await flushAsync();
	}
}

async function stoppedAsync(setup: StartSetup = {}): Promise<StartRun> {
	const run = startCommand(setup);
	await flushAsync();
	run.signals.fire("SIGINT");
	return run;
}

function spawnedIds(fake: FakeReaper): Array<string> {
	return fake.spawned.map(({ id, args }) => `${id}: ${args.join(" ")}`);
}

describe(runSupervisorAsync, () => {
	it("should compile, build, open, then serve Rojo and watch, all through the reaper", async () => {
		expect.assertions(3);

		const run = await stoppedAsync({ flags: {}, projectType: "rbxts" });
		await run.result;

		expect(spawnedIds(run.fake)).toStrictEqual([
			"start-1: ",
			"start-2: build default.project.json --output game.rbxl",
			"rojo: serve default.project.json --port 4000",
			"compiler: -w",
		]);
		expect(run.fake.calls[0]).toBe("go");
		expect(run.studioLauncher).toHaveBeenCalledExactlyOnceWith({
			cwd: PROJECT,
			env: { PATH: TOOLS },
			place: PLACE,
		});
	});

	it("should give every worker the project, the environment, and an output file", async () => {
		expect.assertions(1);

		const run = await stoppedAsync({ flags: { open: false }, projectType: "rbxts" });
		await run.result;

		expect(
			run.fake.spawned.map(({ cwd, env, file, log }) => {
				return { cwd, env, file, log };
			}),
		).toStrictEqual(
			[
				["start-1", "rbxtsc"],
				["start-2", "rojo"],
				["rojo", "rojo"],
				["compiler", "rbxtsc"],
			].map(([id, tool]) => {
				return {
					cwd: PROJECT,
					env: { PATH: TOOLS },
					file: path.join(TOOLS, String(tool)),
					log: path.join(SESSION, "output", `${id}.log`),
				};
			}),
		);
	});

	it("should run only Rojo with --no-open --no-compiler", async () => {
		expect.assertions(4);

		const run = await stoppedAsync({ projectType: "rbxts" });

		await expect(run.result).resolves.toStrictEqual({
			data: { port: 4000, reason: "SIGINT", reports: [] },
			summary: "Stopped on SIGINT; every process of the session is gone.",
		});
		expect(run.fake.launches).toStrictEqual([
			{
				leasePath: path.join(SESSION, "workers.lock"),
				recordPath: path.join(SESSION, "reaper.json"),
				sessionId: "session-1",
			},
		]);
		expect(run.fake.spawned).toStrictEqual([
			{
				id: "rojo",
				args: ["serve", "default.project.json", "--port", "4000"],
				cwd: PROJECT,
				env: { PATH: TOOLS },
				file: path.join(TOOLS, "rojo"),
				log: path.join(SESSION, "output", "rojo.log"),
			},
		]);
		expect(run.studioLauncher).not.toHaveBeenCalled();
	});

	it("should report ready once Rojo runs, naming the port", async () => {
		expect.assertions(1);

		const run = await stoppedAsync();
		await run.result;

		expect(run.reporter.events.at(-1)).toStrictEqual({
			message: "Rojo serves default.project.json on port 4000. Press Ctrl+C to stop.",
			type: "info",
		});
	});

	it("should not report ready after a stop signal while the services start", async () => {
		expect.assertions(1);

		const run: StartRun = startCommand({
			reaper: {
				onSpawn: onSpawnOf("rojo", () => {
					run.signals.fire("SIGINT");
				}),
			},
		});
		await run.result;

		expect(run.reporter.events.map(({ type }) => type)).toStrictEqual(["step", "step"]);
	});

	it("should never open Studio after a stop signal during the build", async () => {
		expect.assertions(2);

		const run: StartRun = startCommand({
			flags: {},
			projectType: "rbxts",
			reaper: {
				onSpawn: onSpawnOf("start-2", () => {
					run.signals.fire("SIGINT");
				}),
			},
		});

		await expect(run.result).resolves.toMatchObject({ data: { reason: "SIGINT" } });
		expect(run.studioLauncher).not.toHaveBeenCalled();
	});

	it("should leave no timer behind once the session ended", async () => {
		expect.assertions(1);

		const run = await stoppedAsync({ flags: { syncback: true } });
		await run.result;

		expect(run.clock.pending()).toBe(0);
	});

	it("should report each step and a ready line", async () => {
		expect.assertions(1);

		const run = await stoppedAsync({ flags: { open: false }, projectType: "rbxts" });
		await run.result;

		expect(run.reporter.events).toStrictEqual([
			{ name: "rbxtsc", status: "started", type: "step" },
			{ name: "rbxtsc", status: "succeeded", type: "step" },
			{ name: "rojo build", status: "started", type: "step" },
			{ name: "rojo build", status: "succeeded", type: "step" },
			{ name: "rojo serve", status: "started", type: "step" },
			{ name: "rojo serve", status: "succeeded", type: "step" },
			{ name: "rbxtsc watch", status: "started", type: "step" },
			{ name: "rbxtsc watch", status: "succeeded", type: "step" },
			{
				message:
					"Rojo serves default.project.json on port 4000. The compiler watches your code. Press Ctrl+C to stop.",
				type: "info",
			},
		]);
	});

	it("should let open build the place when the session has no compiler", async () => {
		expect.assertions(2);

		const run = await stoppedAsync({ flags: { compiler: false }, projectType: "rbxts" });
		await run.result;

		expect(spawnedIds(run.fake)).toStrictEqual([
			"start-1: build default.project.json --output game.rbxl",
			"rojo: serve default.project.json --port 4000",
		]);
		expect(run.studioLauncher).toHaveBeenCalledOnce();
	});

	it("should let open build its own place when it differs from the build output", async () => {
		expect.assertions(1);

		const run = await stoppedAsync({
			file: { open: { buildOutputPath: "other.rbxl" } },
			flags: {},
			projectType: "rbxts",
		});
		await run.result;

		expect(spawnedIds(run.fake).filter((id) => id.includes("build"))).toStrictEqual([
			"start-2: build default.project.json --output game.rbxl",
			"start-3: build default.project.json --output other.rbxl",
		]);
	});

	it("should let open build from its own project", async () => {
		expect.assertions(1);

		const run = await stoppedAsync({
			file: { open: { projectPath: "place.project.json" } },
			flags: {},
			projectType: "rbxts",
		});
		await run.result;

		expect(spawnedIds(run.fake).filter((id) => id.includes("build"))).toStrictEqual([
			"start-2: build default.project.json --output game.rbxl",
			"start-3: build place.project.json --output game.rbxl",
		]);
	});

	it("should run the Luau watch command as the compiler service", async () => {
		expect.assertions(1);

		const run = await stoppedAsync({
			file: { luau: { watch: { args: ["watch"], command: "darklua" } } },
			files: { ...TOOL_FILES, "tools/darklua": "" },
			flags: { open: false },
		});
		await run.result;

		expect(spawnedIds(run.fake)).toStrictEqual([
			"start-1: build default.project.json --output game.rbxl",
			"rojo: serve default.project.json --port 4000",
			"compiler: watch",
		]);
	});

	it("should end with studio_closed once Studio closes the place it opened", async () => {
		expect.assertions(3);

		const run = startCommand({ flags: { compiler: false } });
		await flushAsync();
		run.memory.fileSystem.writeFileSync(LOCK, "1");
		await passAsync(run, FILE_POLL_MS);
		run.memory.fileSystem.rmSync(LOCK);
		await passAsync(run, FILE_POLL_MS);

		await expect(run.result).resolves.toStrictEqual({
			data: { port: 4000, reason: "studio_closed", reports: [] },
			summary: "Studio closed the place; every process of the session is gone.",
		});
		expect(run.reporter.events).toContainEqual({
			message: `Roblox Studio has ${PLACE} open. The session ends when Studio closes it.`,
			type: "info",
		});
		expect(run.fake.calls.at(-1)).toBe("terminate 3000");
	});

	it("should fail with service_failed when Rojo exits, naming its log", async () => {
		expect.assertions(1);

		const run = startCommand();
		await flushAsync();
		run.fake.exit("rojo", EXITED);

		await expect(run.result).rejects.toMatchObject({
			code: "service_failed",
			details: { reason: "service_failed:rojo", reports: [] },
			hint: `Its output is in ${path.join(PROJECT, ".forge", "logs", "rojo.log")}.`,
			message: "rojo exited (exit code 3), so the session stopped.",
		});
	});

	it("should keep Rojo starting until its port listens, then report it ready", async () => {
		expect.assertions(3);

		const answers = [false, false, true];
		const run = startCommand({ isListening: async () => answers.shift()! });
		await flushAsync();
		const before = stateOf(run);
		// Each pass wakes the check once.
		await passAsync(run, 2 * OUTPUT_POLL_MS);
		const after = stateOf(run);
		run.signals.fire("SIGINT");
		await run.result;

		expect(before).toMatchObject({
			phase: "starting",
			services: { rojo: { status: "starting" } },
		});
		expect(after).toMatchObject({
			phase: "ready",
			services: { rojo: { status: "ready" } },
		});
		expect(run.isListeningAsync).toHaveBeenCalledWith(4000);
	});

	it("should not report Rojo ready when a stop signal came while it checked the port", async () => {
		expect.assertions(1);

		const run: StartRun = startCommand({
			isListening: async () => {
				run.signals.fire("SIGINT");
				return true;
			},
		});
		await run.result;

		expect(run.reporter.events).not.toContainEqual(expect.objectContaining({ type: "info" }));
	});

	it("should show a stopping session while Rojo's port check is still going", async () => {
		expect.assertions(1);

		const listening = Promise.withResolvers<boolean>();
		const run = startCommand({ isListening: async () => listening.promise });
		await flushAsync();
		run.signals.fire("SIGINT");
		await flushAsync();
		const during = stateOf(run);
		listening.resolve(true);
		await run.result;

		expect(during).toMatchObject({ phase: "stopping", running: true });
	});

	it("should show a planned compiler as starting before anything runs", async () => {
		expect.assertions(1);

		const states: Array<Promise<unknown>> = [];
		const run: StartRun = startCommand({
			flags: { open: false },
			projectType: "rbxts",
			reaper: {
				onLaunch: () => {
					states.push(callSessionAsync(run.ipc, CONTROL_TARGET, "status"));
					run.signals.fire("SIGTERM");
				},
			},
		});
		await run.result;

		await expect(Promise.all(states)).resolves.toMatchObject([
			{ services: { compiler: { status: "starting" } } },
		]);
	});

	it("should fail with service_failed when Rojo never listens within the bound", async () => {
		expect.assertions(2);

		const run = startCommand({ isListening: async () => false });
		const failed = run.result.catch((err: unknown) => err);
		await flushAsync();
		await passAsync(run, ROJO_LISTEN_BOUND_MS);

		await expect(failed).resolves.toMatchObject({
			code: "service_failed",
			details: { reason: "service_failed:rojo" },
			hint: `Its output is in ${path.join(PROJECT, ".forge", "logs", "rojo.log")}.`,
			message: "rojo did not listen on port 4000 within 60 s, so the session stopped.",
		});
		expect(run.reporter.events).not.toContainEqual(expect.objectContaining({ type: "info" }));
	});

	it("should fail with service_failed when the compiler exits", async () => {
		expect.assertions(1);

		const run = startCommand({ flags: { open: false }, projectType: "rbxts" });
		await flushAsync();
		run.fake.exit("compiler", EXITED);

		await expect(run.result).rejects.toMatchObject({
			code: "service_failed",
			details: { reason: "service_failed:compiler" },
			hint: `Its output is in ${path.join(PROJECT, ".forge", "logs", "compiler.log")}.`,
		});
	});

	it.for([
		[{ exitCode: null, signal: 9 }, "rojo exited (signal 9), so the session stopped."],
		[{ exitCode: null, signal: null }, "rojo exited (killed), so the session stopped."],
	] as const)("should describe an exit of %o", async ([exit, message]) => {
		expect.assertions(1);

		const run = startCommand();
		await flushAsync();
		run.fake.exit("rojo", { ...EXITED, ...exit });

		await expect(run.result).rejects.toMatchObject({ message });
	});

	it("should stop the session and start no service when the compile fails", async () => {
		expect.assertions(2);

		const run = startCommand({
			flags: { open: false },
			oneShot: oneShotsWith({ "start-1": EXITED }),
			projectType: "rbxts",
		});

		await expect(run.result).rejects.toMatchObject({ code: "compile_failed" });
		expect(run.fake.calls).toStrictEqual(["go", "spawn start-1", "terminate 3000"]);
	});

	it("should start nothing after a stop signal during the compile", async () => {
		expect.assertions(3);

		const run = startCommand({
			flags: {},
			oneShot: oneShotsWith({ "start-1": "hold" }),
			projectType: "rbxts",
		});
		await flushAsync();
		run.signals.fire("SIGINT");

		await expect(run.result).resolves.toMatchObject({ data: { reason: "SIGINT" } });
		expect(run.fake.calls).toStrictEqual(["go", "spawn start-1", "terminate 3000"]);
		expect(run.studioLauncher).not.toHaveBeenCalled();
	});

	it("should start no step after a stop signal, even when the running step succeeds", async () => {
		expect.assertions(2);

		const run: StartRun = startCommand({
			flags: {},
			projectType: "rbxts",
			reaper: {
				onSpawn: () => {
					run.signals.fire("SIGINT");
				},
			},
		});

		await expect(run.result).resolves.toMatchObject({ data: { reason: "SIGINT" } });
		expect(run.fake.calls).toStrictEqual(["go", "spawn start-1", "terminate 3000"]);
	});

	it("should start no compiler after a stop signal while Rojo starts", async () => {
		expect.assertions(1);

		const run: StartRun = startCommand({
			flags: { open: false },
			projectType: "rbxts",
			reaper: {
				onSpawn: onSpawnOf("rojo", () => {
					run.signals.fire("SIGTERM");
				}),
			},
		});
		await run.result;

		expect(run.fake.calls).toStrictEqual([
			"go",
			"spawn start-1",
			"spawn start-2",
			"spawn rojo",
			"terminate 3000",
		]);
	});

	it("should write each service's output to its rotated log, without colors", async () => {
		expect.assertions(2);

		const run = startCommand({
			files: { ".forge/logs/rojo.log": "earlier\n", ...TOOL_FILES },
		});
		await flushAsync();
		run.memory.fileSystem.writeFileSync(
			path.join(SESSION, "output", "rojo.log"),
			"\u001B[32m-listening-\u001B[39m\npartial",
		);
		await passAsync(run, OUTPUT_POLL_MS);

		// Read while Rojo runs, not only once it is gone.
		expect(run.memory.files()[".forge/logs/rojo.log"]).toBe(
			"earlier\n--- forge start 2026-01-01T00:00:00.000Z ---\n-listening-\n",
		);

		run.signals.fire("SIGINT");
		await run.result;

		expect(run.memory.files()[".forge/logs/rojo.log"]).toBe(
			"earlier\n--- forge start 2026-01-01T00:00:00.000Z ---\n-listening-\npartial\n",
		);
	});

	it("should report each watch-mode compile with its diagnostics", async () => {
		expect.assertions(1);

		const run = startCommand({ flags: { open: false }, projectType: "rbxts" });
		await flushAsync();
		run.memory.fileSystem.writeFileSync(
			path.join(SESSION, "output", "compiler.log"),
			"src/a.ts:3:7 - error TS2322: Bad.\n\nFound 1 error. Watching for file changes.\n",
		);
		await passAsync(run, OUTPUT_POLL_MS);
		run.signals.fire("SIGINT");
		await run.result;

		expect(run.reporter.events.filter(({ type }) => type === "compiled")).toStrictEqual([
			{
				diagnostics: [
					{
						code: "TS2322",
						column: 7,
						file: "src/a.ts",
						line: 3,
						message: "Bad.",
						severity: "error",
					},
				],
				errors: 1,
				type: "compiled",
			},
		]);
	});

	it("should read the Luau watch command's output only into its log", async () => {
		expect.assertions(1);

		const run = startCommand({
			file: { luau: { watch: { command: "darklua" } } },
			files: { ...TOOL_FILES, "tools/darklua": "" },
			flags: { open: false },
		});
		await flushAsync();
		run.memory.fileSystem.writeFileSync(
			path.join(SESSION, "output", "compiler.log"),
			"Found 1 error.\n",
		);
		await passAsync(run, OUTPUT_POLL_MS);
		run.signals.fire("SIGINT");
		await run.result;

		expect(run.reporter.events.filter(({ type }) => type === "compiled")).toStrictEqual([]);
	});

	it("should remove the session directory and keep the logs when the session ends", async () => {
		expect.assertions(2);

		const run = await stoppedAsync({ flags: { open: false }, projectType: "rbxts" });
		await run.result;
		const files = Object.keys(run.memory.files());

		expect(files).toIncludeAllMembers([".forge/logs/rojo.log", ".forge/logs/start.log"]);
		expect(files.filter((file) => file.includes("sessions/"))).toStrictEqual([]);
	});

	it("should fail with port_in_use when the fixed port is busy, starting nothing", async () => {
		expect.assertions(3);

		const run = startCommand({ isPortFree: false });

		await expect(run.result).rejects.toMatchObject({
			code: "port_in_use",
			hint: "Stop the program that uses it, or set rojoPort to a free port.",
			message: "Rojo port 4000 is in use.",
		});
		expect(run.isPortFreeAsync).toHaveBeenCalledExactlyOnceWith(4000);
		expect(run.fake.launches).toStrictEqual([]);
	});

	it.for([
		["rojo_missing", { "tools/rbxtsc": "" }],
		["compiler_missing", { "tools/rojo": "" }],
	] as const)("should fail with %s before it creates any session file", async ([code, files]) => {
		expect.assertions(2);

		const run = startCommand({ files, flags: {}, projectType: "rbxts" });

		await expect(run.result).rejects.toMatchObject({ code });
		expect(
			Object.keys(run.memory.files()).filter((file) => file.startsWith(".forge")),
		).toStrictEqual([]);
	});

	it("should stop without escalating when every worker stops in time", async () => {
		expect.assertions(2);

		const run = await stoppedAsync();
		const { data } = await run.result;

		expect(Object.keys(data)).not.toContain("escalation");
		expect(run.reporter.events.filter(({ type }) => type === "warning")).toStrictEqual([]);
	});

	it.for([
		[
			"stdin_closed",
			"The reaper did not stop within the grace time; forge closed its stdin, so it forced every tree.",
		],
		[
			"forced_cleanup",
			"The reaper did not stop, even after its stdin closed; forge cleaned up the session by force.",
		],
	] as const)(
		"should warn and report when the reaper's end escalated to %s",
		async ([escalation, message]) => {
			expect.assertions(2);

			const end: ReaperEnd = { escalation, reports: [], terminated: false };
			const run = await stoppedAsync({ reaper: { end } });

			await expect(run.result).resolves.toMatchObject({ data: { escalation } });
			expect(run.reporter.events).toContainEqual({ message, type: "warning" });
		},
	);

	it("should fail with cleanup_in_progress when a worker outlived the wait", async () => {
		expect.assertions(2);

		const reports = [
			{ id: "rojo", report: { ...EXITED, incomplete: true } },
			{ id: "hook", report: EXITED },
			{ id: "compiler", report: { ...EXITED, incomplete: true } },
		];
		const end: ReaperEnd = { reports, terminated: true };
		const run = startCommand({ reaper: { end } });
		await flushAsync();
		run.fake.exit("rojo", EXITED);

		await expect(run.result).rejects.toMatchObject({
			code: "cleanup_in_progress",
			details: { reports, sessionId: "session-1" },
			hint: "Check for them, and stop them by hand.",
			message: "Processes of rojo, compiler were still alive when forge stopped waiting.",
		});
		// The next session's barrier waits for them.
		expect(run.memory.files()).toMatchObject({
			".forge/current": "session-1\n",
			".forge/sessions/session-1/token": "session-1",
		});
	});
});

describe("forge start hooks and syncback", () => {
	/**
	 * Start a syncback session, wait until it watches the place, then save.
	 *
	 * @param setup - The session's setup.
	 * @returns The run, after one save.
	 */
	async function savedAsync(setup: StartSetup = SYNCBACK): Promise<StartRun> {
		const run = startCommand({ files: { ...TOOL_FILES, "game.rbxl": "v1" }, ...setup });
		await flushAsync();
		run.memory.setModifiedTime("game.rbxl", Date.UTC(2026, 0, 2));
		await passAsync(run, FILE_POLL_MS);
		return run;
	}

	it("should not run syncback on a save without --syncback", async () => {
		expect.assertions(1);

		const run = await savedAsync({ ...SYNCBACK, flags: ROJO_ONLY });
		run.signals.fire("SIGINT");
		await run.result;

		expect(spawnedIds(run.fake)).toStrictEqual([
			"rojo: serve default.project.json --port 4000",
		]);
	});

	it("should check Rojo's syncback support before any other step", async () => {
		expect.assertions(2);

		const run = startCommand({
			flags: { syncback: true },
			oneShot: oneShotsWith({ "start-1": { ...OK, exitCode: 2 } }),
			projectType: "rbxts",
		});

		await expect(run.result).rejects.toMatchObject({ code: "syncback_unsupported" });
		expect(spawnedIds(run.fake)).toStrictEqual(["start-1: syncback --help"]);
	});

	it("should run syncback and its post hook as workers when Studio saves the place", async () => {
		expect.assertions(2);

		const run = await savedAsync();
		run.signals.fire("SIGINT");
		await run.result;

		expect(spawnedIds(run.fake)).toStrictEqual([
			"start-1: syncback --help",
			"rojo: serve default.project.json --port 4000",
			"syncback-1: syncback default.project.json --input game.rbxl --non-interactive",
			"syncback-2: -c lint",
		]);
		expect(run.reporter.events).toContainEqual({
			message: `Synced ${PLACE} into default.project.json.`,
			type: "info",
		});
	});

	it("should give a hook the hook stack, so a forge run inside it skips it", async () => {
		expect.assertions(1);

		const run = await savedAsync();
		run.signals.fire("SIGINT");
		await run.result;

		expect(run.fake.spawned.at(-1)!.env).toMatchObject({
			RBX_FORGE_HOOK_STACK: "syncback:post:0",
		});
	});

	it("should fold saves during a syncback into one more run", async () => {
		expect.assertions(1);

		const run = await savedAsync({
			...SYNCBACK,
			oneShot: oneShotsWith({ "syncback-1": "hold" }),
		});
		for (const day of [3, 4, 5]) {
			run.memory.setModifiedTime("game.rbxl", Date.UTC(2026, 0, day));
			await passAsync(run, FILE_POLL_MS);
		}

		run.fake.exit("syncback-1", OK);
		await passAsync(run, FILE_POLL_MS);
		run.signals.fire("SIGINT");
		await run.result;

		expect(spawnedIds(run.fake).filter((id) => id.includes("--input"))).toHaveLength(2);
	});

	it("should report a failed syncback and keep the session running", async () => {
		expect.assertions(2);

		const run = await savedAsync({
			...SYNCBACK,
			oneShot: oneShotsWith({ "syncback-1": EXITED }),
		});
		await passAsync(run, FILE_POLL_MS);

		expect(run.reporter.events).toContainEqual({
			message: "Syncback failed: rojo syncback failed (exit code 3).",
			type: "warning",
		});

		run.signals.fire("SIGINT");

		await expect(run.result).resolves.toMatchObject({ data: { reason: "SIGINT" } });
	});

	it("should keep each syncback run and its hooks in the status", async () => {
		expect.assertions(1);

		const run = await savedAsync();

		expect(stateOf(run)).toMatchObject({
			services: {
				syncback: {
					lastRun: {
						at: "2026-01-01T00:00:00.500Z",
						durationMs: 0,
						hooks: [
							{
								id: "syncback:post:0",
								command: "lint",
								ok: true,
								outcome: "succeeded",
							},
						],
						ok: true,
					},
					status: "idle",
				},
			},
		});
	});

	it.for([
		["the hook", "syncback-2", "hook_failed", 1],
		["Rojo", "syncback-1", "process_failed", 0],
	] as const)(
		"should keep a syncback run that %s failed, with its error and hooks",
		async ([, worker, code, hooks]) => {
			expect.assertions(2);

			const run = await savedAsync({
				...SYNCBACK,
				oneShot: oneShotsWith({ [worker]: EXITED }),
			});
			const state = stateOf(run);

			expect(state).toMatchObject({
				services: { syncback: { lastRun: { error: { code }, ok: false }, status: "idle" } },
			});
			expect(state).toHaveProperty(
				"services.syncback.lastRun.hooks",
				expect.toBeArrayOfSize(hooks),
			);
		},
	);

	it("should report a running syncback as running", async () => {
		expect.assertions(1);

		const run = await savedAsync({
			...SYNCBACK,
			oneShot: oneShotsWith({ "syncback-1": "hold" }),
		});

		expect(stateOf(run)).toMatchObject({ services: { syncback: { status: "running" } } });
	});

	it.for([
		["succeeded", OK, true],
		["failed", EXITED, false],
	] as const)("should keep how long a syncback run that %s took", async ([, report, isOk]) => {
		expect.assertions(1);

		const run = await savedAsync({
			...SYNCBACK,
			oneShot: oneShotsWith({ "syncback-1": "hold" }),
		});
		await passAsync(run, 1000);
		run.fake.exit("syncback-1", report);
		await passAsync(run, OUTPUT_POLL_MS);

		expect(stateOf(run)).toMatchObject({
			services: { syncback: { lastRun: { durationMs: 1250, ok: isOk } } },
		});
	});

	it("should not report a syncback the session's end cut short", async () => {
		expect.assertions(1);

		const run = await savedAsync({
			...SYNCBACK,
			oneShot: oneShotsWith({ "syncback-1": "hold" }),
		});
		run.signals.fire("SIGINT");
		await run.result;

		expect(run.reporter.events.filter(({ type }) => type === "warning")).toStrictEqual([]);
	});

	it("should run build hooks as workers of the session", async () => {
		expect.assertions(1);

		const run = await stoppedAsync({
			file: { hooks: { build: { pre: ["codegen"] } } },
			flags: { open: false },
			projectType: "rbxts",
		});
		await run.result;

		expect(spawnedIds(run.fake).slice(0, 3)).toStrictEqual([
			"start-1: ",
			"start-2: -c codegen",
			"start-3: build default.project.json --output game.rbxl",
		]);
	});
});

describe("forge start session files", () => {
	it("should write the identity record, token, and current hint before the reaper starts", async () => {
		expect.assertions(2);

		let files: Record<string, null | string> = {};
		const run: StartRun = startCommand({
			reaper: {
				onLaunch: () => {
					files = run.memory.files();
				},
			},
		});
		await flushAsync();
		run.signals.fire("SIGINT");
		await run.result;

		const { endpoint, ...identity } = identityIn(files);

		expect([endpoint, identity]).toStrictEqual([
			endpointFor({
				buildOutputPath: "game.rbxl",
				env: {},
				platform: "linux",
				projectRoot: PROJECT,
				userId: 1000,
			}),
			IDENTITY,
		]);
		expect(files).toMatchObject({
			".forge/current": "session-1\n",
			".forge/sessions/session-1/token": "session-1",
		});
	});

	it("should hold the singleton lock for the whole run and release it at the end", async () => {
		expect.assertions(2);

		let held: Array<string> | undefined;
		const run: StartRun = startCommand({
			reaper: {
				onLaunch: () => {
					held = run.native.locks.get(SINGLETON);
				},
			},
		});
		await flushAsync();
		run.signals.fire("SIGINT");
		await run.result;

		expect(held).toStrictEqual(["exclusive"]);
		expect(run.native.locks.size).toBe(0);
	});

	it("should delete the current hint with the session directory", async () => {
		expect.assertions(1);

		const run = await stoppedAsync();
		await run.result;

		expect(
			Object.keys(run.memory.files()).filter((file) => file.startsWith(".forge/")),
		).toIncludeSameMembers([".forge/logs/rojo.log", ".forge/sessions"]);
	});

	it("should refuse with session_running while another supervisor holds the lock, starting nothing", async () => {
		expect.assertions(3);

		const run = startCommand();
		run.native.addon.tryLockFile(SINGLETON, "exclusive");

		await expect(run.result).rejects.toMatchObject({
			code: "session_running",
			hint: "Stop it first (Ctrl+C in its terminal), then start again.",
		});
		expect(run.fake.launches).toStrictEqual([]);
		expect(Object.keys(run.memory.files())).not.toContain(".forge/current");
	});

	it("should end with owner_gone when the owner pipe closes", async () => {
		expect.assertions(1);

		const run = startCommand();
		await flushAsync();
		run.stop.request({ type: "owner_gone" });

		await expect(run.result).resolves.toMatchObject({
			data: { port: 4000, reason: "owner_gone" },
			summary: "forge start is gone; every process of the session is gone.",
		});
	});

	it.for(["created", "lock"] as const)(
		"should take no lock and start nothing when stopped while paused at %s",
		async (point) => {
			expect.assertions(3);

			const run = startCommand({ pause: (stop) => stopAt(point, stop) });

			await expect(run.result).resolves.toStrictEqual({
				data: { reason: "SIGTERM", reports: [] },
				summary: "Stopped on SIGTERM before the session started; nothing ran.",
			});
			expect([run.fake.launches, run.isPortFreeAsync.mock.calls]).toStrictEqual([[], []]);
			expect([run.native.locks.size, run.memory.files()[".forge/current"]]).toStrictEqual([
				0,
				undefined,
			]);
		},
	);

	it("should pause at control with the session's files written and no endpoint yet, and start nothing once stopped there", async () => {
		expect.assertions(2);

		const seen: Array<unknown> = [];
		const run = startCommand({
			pause: (stop) => {
				return noteAndStopAt("control", stop, () => {
					seen.push(run.memory.files()[".forge/current"], run.ipc.endpoints.size);
				});
			},
		});

		await expect(run.result).resolves.toMatchObject({
			data: { reason: "SIGTERM", reports: [] },
		});
		expect([seen, run.fake.calls]).toStrictEqual([["session-1\n", 0], ["terminate 3000"]]);
	});

	it("should name owner_gone when the owner went before the session started", async () => {
		expect.assertions(1);

		const run = startCommand({
			pause: (stop) => async () => {
				stop.request({ type: "owner_gone" });
			},
		});

		await expect(run.result).resolves.toMatchObject({
			data: { reason: "owner_gone" },
			summary: "Stopped on owner_gone before the session started; nothing ran.",
		});
	});

	it("should delete older sessions whose lease is free before it creates its own", async () => {
		expect.assertions(1);

		const run = startCommand({ files: WITH_OLD });
		await flushAsync();
		run.signals.fire("SIGINT");
		await run.result;

		expect(
			Object.keys(run.memory.files()).filter((file) => file.includes("sessions/")),
		).toStrictEqual([]);
	});

	it("should fail with previous_generation_alive while an older session's lease is held", async () => {
		expect.assertions(2);

		const run = startCommand({ files: WITH_OLD });
		run.native.addon.tryLockFile(OLD_LEASE, "shared");
		const caught = run.result.catch((err: unknown) => err);
		// The default grace time (3 s) plus the 15 s margin, and one poll.
		await passAsync(run, 18_250);

		await expect(caught).resolves.toMatchObject({
			code: "previous_generation_alive",
			hint: `Wait for them to exit, or run again with --force to kill them. Their session files are in ${path.dirname(OLD_LEASE)}.`,
		});
		expect(run.fake.launches).toStrictEqual([]);
	});

	it("should kill an older session that outlives the wait with --force, then start", async () => {
		expect.assertions(4);

		const run = startCommand({ files: WITH_OLD, flags: { ...ROJO_ONLY, force: true } });
		const lease = run.native.addon.tryLockFile(OLD_LEASE, "shared");
		assert(lease !== null);
		run.native.sessions.set("old", [{ isReaper: true, lease, pid: 77 }, { pid: 78 }]);
		await passAsync(run, 18_250);
		run.signals.fire("SIGINT");
		const cleanups = [{ killed: [78, 77], sessionId: "old", survivors: [], unverifiable: [] }];

		await expect(run.result).resolves.toMatchObject({ data: { cleanups } });
		expect(run.native.cleanups).toMatchObject([{ target: { sessionId: "old" } }]);
		expect(run.reporter.events).toContainEqual({
			message: "--force killed 2 processes of the earlier session old.",
			type: "warning",
		});
		expect(run.fake.launches).toHaveLength(1);
	});

	it("should leave cleanups out of the result when no older session needed one", async () => {
		expect.assertions(1);

		const run = await stoppedAsync({ files: WITH_OLD, flags: { ...ROJO_ONLY, force: true } });
		const { data } = await run.result;

		expect(Object.keys(data)).not.toContain("cleanups");
	});

	it("should create no session when stopped while it waits for an older session", async () => {
		expect.assertions(2);

		const run = startCommand({ files: WITH_OLD });
		run.native.addon.tryLockFile(OLD_LEASE, "shared");
		await flushAsync();
		run.signals.fire("SIGINT");

		await expect(run.result).resolves.toMatchObject({
			summary: "Stopped on SIGINT before the session started; nothing ran.",
		});
		expect(run.fake.launches).toStrictEqual([]);
	});

	it("should fail with cleanup_in_progress and keep the session while its lease stays held", async () => {
		expect.assertions(2);

		const run = startCommand();
		await flushAsync();
		run.native.addon.tryLockFile(path.join(SESSION, "workers.lock"), "shared");
		run.signals.fire("SIGINT");
		const caught = run.result.catch((err: unknown) => err);
		await passAsync(run, 5250);

		await expect(caught).resolves.toMatchObject({
			code: "cleanup_in_progress",
			message: "Processes of the session were still alive when forge stopped waiting.",
		});
		expect(run.memory.files()[".forge/current"]).toBe("session-1\n");
	});

	it("should name the surviving PIDs when the final barrier times out", async () => {
		expect.assertions(1);

		const run = startCommand();
		await flushAsync();
		run.native.sessions.set("session-1", [{ pid: 91 }, { pid: 92 }]);
		run.signals.fire("SIGINT");
		const caught = run.result.catch((err: unknown) => err);
		await passAsync(run, 5250);

		await expect(caught).resolves.toMatchObject({
			code: "cleanup_in_progress",
			details: { pids: [91, 92], sessionId: "session-1" },
			message:
				"Processes of the session were still alive when forge stopped waiting (PIDs 91, 92).",
		});
	});

	it("should delete the session files when the reaper does not start", async () => {
		expect.assertions(2);

		const error = new ForgeError("reaper_unavailable", "no reaper");
		const run = startCommand({ reaper: { launchError: error } });

		await expect(run.result).rejects.toBe(error);
		expect(
			Object.keys(run.memory.files()).filter((file) => file.startsWith(".forge/")),
		).toStrictEqual([".forge/sessions"]);
	});
});

const CONTROL_TARGET = {
	endpoint: endpointFor({
		buildOutputPath: "game.rbxl",
		env: {},
		platform: "linux",
		projectRoot: PROJECT,
		userId: 1000,
	}),
	token: "session-1",
};

describe("forge up control channel", () => {
	it("should serve its status on the control endpoint while it runs, then close it", async () => {
		expect.assertions(2);

		const run = startCommand();
		await flushAsync();
		const status = await callSessionAsync(run.ipc, CONTROL_TARGET, "status");
		run.signals.fire("SIGINT");
		await run.result;

		expect(status).toStrictEqual({
			phase: "ready",
			pid: 4242,
			running: true,
			services: {
				compiler: { status: "off" },
				rojo: { port: 4000, status: "ready" },
				studio: { status: "off" },
				syncback: { status: "off" },
			},
			sessionId: "session-1",
			startedAt: IDENTITY.startedAt,
		});
		await expect(callSessionAsync(run.ipc, CONTROL_TARGET, "status")).rejects.toMatchObject({
			code: "not_running",
		});
	});

	it("should stop with reason shutdown when asked on the control channel", async () => {
		expect.assertions(2);

		const run = startCommand();
		await flushAsync();

		await expect(callSessionAsync(run.ipc, CONTROL_TARGET, "shutdown")).resolves.toStrictEqual({
			accepted: true,
			sessionId: "session-1",
		});
		await expect(run.result).resolves.toStrictEqual({
			data: { port: 4000, reason: "shutdown", reports: [] },
			summary: "Stopped on request; every process of the session is gone.",
		});
	});

	it("should end the workers' grace on a forced shutdown", async () => {
		expect.assertions(1);

		const run = startCommand();
		await flushAsync();
		await callSessionAsync(run.ipc, CONTROL_TARGET, "shutdown", {
			params: { force: true, sessionId: "session-1" },
		});
		await run.result;

		expect(run.fake.calls.at(-1)).toBe("terminate 3000 hurried");
	});

	it("should call onReady once, when the session is first ready", async () => {
		expect.assertions(2);

		const onReady = vi.fn<() => void>();
		const run = startCommand({ flags: { open: false }, onReady, projectType: "rbxts" });
		await flushAsync();
		const beforeCompile = onReady.mock.calls.length;
		run.memory.fileSystem.writeFileSync(
			path.join(SESSION, "output", "compiler.log"),
			"Found 0 errors. Watching for file changes.\nFound 0 errors. Watching for file changes.\n",
		);
		await passAsync(run, OUTPUT_POLL_MS);
		run.signals.fire("SIGINT");
		await run.result;

		expect(beforeCompile).toBe(0);
		expect(onReady).toHaveBeenCalledOnce();
	});

	it("should never call onReady for a session stopped while its services start", async () => {
		expect.assertions(1);

		const onReady = vi.fn<() => void>();
		const run: StartRun = startCommand({
			onReady,
			reaper: {
				onSpawn: onSpawnOf("rojo", () => {
					run.signals.fire("SIGINT");
				}),
			},
		});
		await run.result;

		expect(onReady).not.toHaveBeenCalled();
	});

	it("should keep the compiler's last build with its diagnostics in state.json", async () => {
		expect.assertions(1);

		const run = startCommand({ flags: { open: false }, projectType: "rbxts" });
		await flushAsync();
		run.memory.fileSystem.writeFileSync(
			path.join(SESSION, "output", "compiler.log"),
			"src/a.ts:3:7 - error TS2322: Bad.\n\nFound 1 error. Watching for file changes.\n",
		);
		await passAsync(run, OUTPUT_POLL_MS);

		expect(stateOf(run)).toMatchObject({
			phase: "ready",
			services: {
				compiler: {
					lastBuild: {
						at: "2026-01-01T00:00:00.250Z",
						diagnostics: [{ code: "TS2322", file: "src/a.ts", line: 3 }],
						errors: 1,
					},
					status: "ready",
				},
			},
		});
	});

	it("should be ready once a Luau watch command runs, with no compile", async () => {
		expect.assertions(1);

		const run = startCommand({
			file: { luau: { watch: { command: "darklua" } } },
			files: { ...TOOL_FILES, "tools/darklua": "" },
			flags: { open: false },
		});
		await flushAsync();

		expect(stateOf(run)).toMatchObject({
			phase: "ready",
			services: { compiler: { status: "ready" } },
		});
	});

	it("should show Studio closed once it closes the place", async () => {
		expect.assertions(1);

		const run = startCommand({ flags: { compiler: false } });
		await flushAsync();
		run.memory.fileSystem.writeFileSync(LOCK, "1");
		await passAsync(run, FILE_POLL_MS);
		// Keep the session's files while its end runs.
		run.native.addon.tryLockFile(path.join(SESSION, "workers.lock"), "shared");
		run.memory.fileSystem.rmSync(LOCK);
		const caught = run.result.catch((err: unknown) => err);
		await passAsync(run, 5750);
		await caught;

		expect(stateOf(run)).toMatchObject({ services: { studio: { status: "closed" } } });
	});

	it("should show a stopping session, with Studio still open, while its workers go", async () => {
		expect.assertions(2);

		const run = startCommand({ flags: { compiler: false } });
		await flushAsync();
		run.memory.fileSystem.writeFileSync(LOCK, "1");
		await passAsync(run, FILE_POLL_MS);
		const open = stateOf(run);
		run.native.addon.tryLockFile(path.join(SESSION, "workers.lock"), "shared");
		run.signals.fire("SIGINT");
		const caught = run.result.catch((err: unknown) => err);
		await passAsync(run, 5250);
		await caught;

		expect(open).toMatchObject({ phase: "ready", services: { studio: { status: "open" } } });
		expect(stateOf(run)).toMatchObject({
			phase: "stopping",
			running: true,
			services: { studio: { status: "open" } },
		});
	});

	it("should write the token through the addon, owner-only, on Windows", async () => {
		expect.assertions(2);

		const writePrivateFile = vi.fn<(file: string, text: string) => void>();
		const run = startCommand({
			files: { "tools/rojo.exe": "" },
			platform: "win32",
			writePrivateFile,
		});
		await flushAsync();
		const files = run.memory.files();
		run.signals.fire("SIGINT");
		await run.result;

		expect(writePrivateFile).toHaveBeenCalledExactlyOnceWith(
			path.join(SESSION, "token"),
			"session-1",
		);
		expect(files[".forge/sessions/session-1/token"]).toBeUndefined();
	});

	it("should delete the session files and start nothing when the endpoint cannot open", async () => {
		expect.assertions(3);

		const error = new ForgeError("endpoint_in_use", "held");
		const run = startCommand({
			ipc: () => {
				return {
					...createMemoryTransport(),
					listenAsync: async () => {
						throw error;
					},
				};
			},
		});

		await expect(run.result).rejects.toBe(error);
		expect(run.fake.launches).toStrictEqual([]);
		expect(
			Object.keys(run.memory.files()).filter((file) => file.startsWith(".forge/")),
		).toStrictEqual([".forge/sessions"]);
	});
});

/** A sync call that may take as long as the test needs. */
const SYNC_CALL = { responseTimeoutMs: 60_000 };
const LINT_HOOK: StartSetup = {
	file: { hooks: { syncback: { post: ["lint"] } } },
	files: { ...TOOL_FILES, "game.rbxl": "v1" },
};

/**
 * Ask the session for a sync, and let time pass until it answers.
 *
 * @param run - The session.
 * @returns The answer, or the failure it rejected with.
 */
async function syncAsync(run: StartRun): Promise<unknown> {
	const answer = callSessionAsync(run.ipc, CONTROL_TARGET, "sync", SYNC_CALL).catch(
		(err: unknown) => err,
	);
	await passAsync(run, FILE_POLL_MS);
	return answer;
}

describe("forge sync control channel", () => {
	it("should run syncback with its hooks in a session without the save watch", async () => {
		expect.assertions(3);

		const run = startCommand(LINT_HOOK);
		await flushAsync();
		const answer = await syncAsync(run);
		const state = stateOf(run);
		run.signals.fire("SIGINT");
		await run.result;

		expect(answer).toStrictEqual({
			durationMs: 0,
			hooks: [expect.objectContaining({ command: "lint", ok: true })],
			input: PLACE,
			project: "default.project.json",
		});
		expect(spawnedIds(run.fake)).toStrictEqual([
			"rojo: serve default.project.json --port 4000",
			"syncback-1: syncback --help",
			"syncback-2: syncback default.project.json --input game.rbxl --non-interactive",
			"syncback-3: -c lint",
		]);
		expect(state).toMatchObject({
			services: { syncback: { lastRun: { ok: true }, status: "off" } },
		});
	});

	it("should answer a failed run with its error code and its hooks", async () => {
		expect.assertions(1);

		const run = startCommand({
			...LINT_HOOK,
			oneShot: oneShotsWith({ "syncback-3": EXITED }),
		});
		await flushAsync();
		const answer = await syncAsync(run);
		run.signals.fire("SIGINT");
		await run.result;

		expect(answer).toMatchObject({
			code: "hook_failed",
			details: { hooks: [expect.objectContaining({ command: "lint", ok: false })] },
		});
	});

	it("should check Rojo's syncback support once, and again only after a failed check", async () => {
		expect.assertions(2);

		const run = startCommand({
			...LINT_HOOK,
			oneShot: oneShotsWith({ "syncback-1": { ...OK, exitCode: 2 } }),
		});
		await flushAsync();
		const first = await syncAsync(run);
		await syncAsync(run);
		await syncAsync(run);
		run.signals.fire("SIGINT");
		await run.result;

		expect(first).toMatchObject({ code: "syncback_unsupported" });
		expect(spawnedIds(run.fake).filter((id) => id.endsWith("--help"))).toStrictEqual([
			"syncback-1: syncback --help",
			"syncback-2: syncback --help",
		]);
	});

	it("should run after the save watch's run, never alongside it", async () => {
		expect.assertions(2);

		const run = startCommand({
			...SYNCBACK,
			files: { ...TOOL_FILES, "game.rbxl": "v1" },
			oneShot: oneShotsWith({ "syncback-1": "hold" }),
		});
		await flushAsync();
		run.memory.setModifiedTime("game.rbxl", Date.UTC(2026, 0, 2));
		const answer = syncAsync(run);
		await passAsync(run, FILE_POLL_MS);
		const during = spawnedIds(run.fake).filter((id) => id.includes("--input"));
		run.fake.exit("syncback-1", OK);
		await answer;
		run.signals.fire("SIGINT");
		await run.result;

		expect(during).toStrictEqual([
			"syncback-1: syncback default.project.json --input game.rbxl --non-interactive",
		]);
		expect(spawnedIds(run.fake).filter((id) => id.includes("--input"))).toHaveLength(2);
	});

	it("should answer not_running once a stop request came", async () => {
		expect.assertions(1);

		const run = startCommand(LINT_HOOK);
		await flushAsync();
		// A worker's lease holds the final barrier, so the session stays up.
		run.native.addon.tryLockFile(path.join(SESSION, "workers.lock"), "shared");
		run.signals.fire("SIGINT");
		await flushAsync();
		const answer = syncAsync(run);
		const ended = run.result.catch((err: unknown) => err);
		await passAsync(run, 5250);
		await ended;

		await expect(answer).resolves.toMatchObject({
			code: "not_running",
			hint: 'Start a session with "forge up", or run "forge syncback".',
		});
	});

	it("should answer not_running when the session stops before syncback can run", async () => {
		expect.assertions(1);

		const run = startCommand({
			flags: { open: false },
			oneShot: oneShotsWith({ "start-1": "hold" }),
			projectType: "rbxts",
		});
		await flushAsync();
		const answer = callSessionAsync(run.ipc, CONTROL_TARGET, "sync", SYNC_CALL);
		await flushAsync();
		run.signals.fire("SIGINT");
		await run.result.catch(ignoreFailure);

		await expect(answer).rejects.toMatchObject({ code: "not_running" });
	});
});

function ignoreFailure(): void {
	// The compile the stop cut short fails; only the sync answer matters.
}
