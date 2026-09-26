import path from "node:path";
import { assert, describe, expect, it, vi } from "vitest";

import { createMemoryTransport } from "../../test/helpers/fake-ipc.ts";
import type { MemoryTransport } from "../../test/helpers/fake-ipc.ts";
import { createFakeReaper, createFakeSignals } from "../../test/helpers/fake-reaper.ts";
import type { FakeReaper, FakeReaperOptions, FakeSignals } from "../../test/helpers/fake-reaper.ts";
import { createManualClock } from "../../test/helpers/manual-clock.ts";
import type { ManualClock } from "../../test/helpers/manual-clock.ts";
import { createFakeNative } from "../../test/helpers/native.ts";
import type { FakeNative, FakeProcess } from "../../test/helpers/native.ts";
import {
	createCommandContext,
	createMemoryFileSystem,
	createRecordingReporter,
	createTestSeams,
	PROJECT,
	TEST_HOSTNAME,
} from "../../test/helpers/seams.ts";
import type { MemoryFileSystem, RecordingReporter } from "../../test/helpers/seams.ts";
import type { FlagValues } from "../cli/flags.ts";
import { ForgeError } from "../errors.ts";
import { callSessionAsync, ownSessionAsync } from "../ipc/client.ts";
import type { OwnedSession } from "../ipc/client.ts";
import type { WorkerReport, WorkerSpec } from "../reaper/protocol.ts";
import type { ReaperEnd } from "../reaper/reaper-client.ts";
import type { ConfigLoader } from "../seams/config-loader.ts";
import type { Network } from "../seams/network.ts";
import type { CommandResult } from "../seams/reporter.ts";
import type { Pause, PausePoint } from "../session/pause.ts";
import { neverPauseAsync } from "../session/pause.ts";
import { ROJO_LISTEN_BOUND_MS } from "../session/rojo-part.ts";
import { OUTPUT_POLL_MS, PART_TAIL_LINES } from "../session/service-parts.ts";
import type { StopSource } from "../session/stop-source.ts";
import { createStopSource } from "../session/stop-source.ts";
import { STUDIO_OPEN_BOUND_MS } from "../session/studio-part.ts";
import { FILE_POLL_MS } from "../session/worker-context.ts";
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
/** The port the OS gives out as free. */
const FREE_PORT = 50_000;
/** A Studio that opened the place at boot, before the test. */
const STUDIO_PID = 777;
const OPEN_STUDIO: Record<number, FakeProcess> = {
	[STUDIO_PID]: { alive: true, executablePath: "/opt/RobloxStudio", startTime: "0" },
};
const STUDIO_LOCK = `${STUDIO_PID}\nRobloxStudio\n${TEST_HOSTNAME}\n`;
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
	/** A `start` owns the session over its owner pipe. */
	owned?: boolean;
	/** Makes the test pause points from the run's stop source. */
	pause?: (stop: StopSource) => Pause;
	/** The host OS; Linux by default. */
	platform?: NodeJS.Platform;
	/** More processes in the fake process table, such as a Studio. */
	processes?: Record<number, FakeProcess>;
	projectType?: "luau" | "rbxts";
	reaper?: FakeReaperOptions;
	/** The config file's `rojoPort`; 4000 by default. */
	rojoPort?: "unset" | number;
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
	/** Gets the result of an owner's end that left the session running. */
	onReleased: ReturnType<typeof vi.fn<(result: CommandResult) => void>>;
	/** The owner pipe's ends. */
	owner: StopSource;
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
		rojo: flags["rojo"] !== false,
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
	owned = false,
	pause = () => neverPauseAsync,
	platform = "linux",
	processes = {},
	projectType = "luau",
	reaper = {},
	rojoPort = 4000,
	writePrivateFile,
}: StartSetup = {}): StartRun {
	const memory = createMemoryFileSystem(files);
	const clock = createManualClock(Date.UTC(2026, 0, 1));
	const fake = createFakeReaper({ autoExit: oneShot, ...reaper });
	const signals = createFakeSignals();
	const stop = createStopSource();
	signals.onStop(stop.request);
	const owner = createStopSource();
	const onReleased = vi.fn<(result: CommandResult) => void>();
	const ipc = makeTransport();
	const seams = createTestSeams();
	const native = createFakeNative({
		4242: { alive: true, executablePath: "/node" },
		...processes,
	});
	const reporter = createRecordingReporter();
	const isPortFreeAsync = vi.fn<Network["isPortFreeAsync"]>().mockResolvedValue(isPortFree);
	const isListeningAsync = vi.fn<Network["isListeningAsync"]>(isListening);
	const freePortAsync = vi.fn<Network["freePortAsync"]>().mockResolvedValue(FREE_PORT);
	const studioLauncher = vi.fn<StudioLauncher>().mockResolvedValue({ type: "launched" });
	const configLoader = vi.fn<ConfigLoader>().mockResolvedValue({
		path: path.join(PROJECT, "rbx-forge.config.ts"),
		value: { projectType, ...(rojoPort === "unset" ? {} : { rojoPort }), ...file },
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
			network: { freePortAsync, isListeningAsync, isPortFreeAsync },
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
		onReleased,
		owner,
		reporter,
		result: runSupervisorAsync(context, requestFor(flags), {
			onReady,
			owner: owned ? { onEnd: owner.onStop, onReleased } : undefined,
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

	it("should stop nothing once the Studio its owner opened closes the place", async () => {
		expect.assertions(4);

		const run = startCommand({ flags: { compiler: false }, owned: true });
		await flushAsync();
		run.memory.fileSystem.writeFileSync(LOCK, "1");
		await passAsync(run, FILE_POLL_MS);
		run.memory.fileSystem.rmSync(LOCK);
		await passAsync(run, FILE_POLL_MS);
		const closed = stateOf(run);
		run.owner.request({ signal: "SIGINT", type: "signal" });

		expect(closed).toMatchObject({
			phase: "ready",
			services: {
				rojo: { owner: "start", status: "ready" },
				studio: { owner: "start", place: PLACE, status: "closed" },
			},
		});
		await expect(run.result).resolves.toStrictEqual({
			data: { port: 4000, reason: "SIGINT", reports: [] },
			summary: "Stopped on SIGINT; every process of the session is gone.",
		});
		expect(run.reporter.events).toContainEqual({
			message: `Roblox Studio has ${PLACE} open.`,
			type: "info",
		});
		expect(run.fake.calls).toStrictEqual([
			"go",
			"spawn start-1",
			"spawn rojo",
			"terminate 3000",
		]);
	});

	it("should stop only Rojo once the Studio it opened with no owner closes the place", async () => {
		expect.assertions(2);

		const run = startCommand({ flags: { compiler: false } });
		await flushAsync();
		run.memory.fileSystem.writeFileSync(LOCK, "1");
		await passAsync(run, FILE_POLL_MS);
		run.memory.fileSystem.rmSync(LOCK);
		await passAsync(run, FILE_POLL_MS);
		run.fake.exit("rojo", OK);
		await passAsync(run, OUTPUT_POLL_MS);
		const closed = stateOf(run);
		run.signals.fire("SIGINT");
		await run.result;

		expect(closed).toMatchObject({
			phase: "ready",
			services: { rojo: { status: "off" }, studio: { place: PLACE, status: "closed" } },
		});
		expect(run.fake.calls).toContain("stop rojo 3000");
	});

	it("should attach the Studio that has the place open: no build, no launch", async () => {
		expect.assertions(4);

		const run = startCommand({
			files: { ...TOOL_FILES, "game.rbxl.lock": STUDIO_LOCK },
			flags: {},
			processes: OPEN_STUDIO,
			projectType: "rbxts",
		});
		await passAsync(run, FILE_POLL_MS);
		const open = stateOf(run);
		run.signals.fire("SIGINT");

		await expect(run.result).resolves.toMatchObject({ data: { reason: "SIGINT" } });
		expect(spawnedIds(run.fake)).toStrictEqual([
			"start-1: ",
			"rojo: serve default.project.json --port 4000",
			"compiler: -w",
		]);
		expect(run.studioLauncher).not.toHaveBeenCalled();
		expect(open).toMatchObject({
			services: {
				studio: { pid: STUDIO_PID, place: PLACE, startTime: "0", status: "open" },
			},
		});
	});

	it("should say it uses the Studio that has the place open", async () => {
		expect.assertions(1);

		const run = await stoppedAsync({
			files: { ...TOOL_FILES, "game.rbxl.lock": STUDIO_LOCK },
			flags: { compiler: false },
			processes: OPEN_STUDIO,
		});
		await run.result;

		expect(run.reporter.events).toContainEqual({
			message: `Roblox Studio (PID ${STUDIO_PID}) already has ${PLACE} open, so the session uses it.`,
			type: "info",
		});
	});

	it("should still build the session's place when the attached Studio has another one open", async () => {
		expect.assertions(2);

		const run = await stoppedAsync({
			file: { open: { buildOutputPath: "other.rbxl" } },
			files: { ...TOOL_FILES, "other.rbxl.lock": STUDIO_LOCK },
			flags: {},
			processes: OPEN_STUDIO,
			projectType: "rbxts",
		});
		await run.result;

		expect(spawnedIds(run.fake).filter((id) => id.includes("build"))).toStrictEqual([
			"start-2: build default.project.json --output game.rbxl",
		]);
		expect(run.studioLauncher).not.toHaveBeenCalled();
	});

	it("should build and launch Studio when the lock file names no Studio", async () => {
		expect.assertions(2);

		const run = await stoppedAsync({
			files: { ...TOOL_FILES, "game.rbxl.lock": STUDIO_LOCK },
			flags: { compiler: false },
			processes: { [STUDIO_PID]: { alive: true, executablePath: "/usr/bin/vim" } },
			projectType: "rbxts",
		});
		await run.result;

		expect(spawnedIds(run.fake)).toContain(
			"start-1: build default.project.json --output game.rbxl",
		);
		expect(run.studioLauncher).toHaveBeenCalledOnce();
	});

	it("should launch Studio when the Studio the lock file names has exited", async () => {
		expect.assertions(1);

		const run = await stoppedAsync({
			files: { ...TOOL_FILES, "game.rbxl.lock": STUDIO_LOCK },
			flags: { compiler: false },
		});
		await run.result;

		expect(run.studioLauncher).toHaveBeenCalledOnce();
	});

	it("should wait for the Studio it launched, not the one an old lock file names", async () => {
		expect.assertions(2);

		const run = startCommand({
			files: { ...TOOL_FILES, "game.rbxl.lock": STUDIO_LOCK },
			flags: { compiler: false },
		});
		run.studioLauncher.mockResolvedValue({
			studio: { pid: 900, startTime: "900" },
			type: "launched",
		});
		await passAsync(run, FILE_POLL_MS);
		const opening = stateOf(run);
		run.memory.fileSystem.writeFileSync(LOCK, `900\nRobloxStudioBeta\n${TEST_HOSTNAME}\n`);
		await passAsync(run, FILE_POLL_MS);
		const open = stateOf(run);
		run.signals.fire("SIGINT");
		await run.result;

		expect(opening).toMatchObject({ services: { studio: { status: "opening" } } });
		expect(open).toMatchObject({ services: { studio: { pid: 900, status: "open" } } });
	});

	it("should mark only Rojo failed when it exits, with its exit code and output tail", async () => {
		expect.assertions(4);

		const run = startCommand({ flags: { open: false }, projectType: "rbxts" });
		await flushAsync();
		run.memory.fileSystem.writeFileSync(
			path.join(SESSION, "output", "rojo.log"),
			"\u001B[32m-first-\u001B[39m\nlast\n",
		);
		run.fake.exit("rojo", EXITED);
		await passAsync(run, OUTPUT_POLL_MS);
		const state = stateOf(run);
		const calls = [...run.fake.calls];
		run.signals.fire("SIGINT");

		expect(state).toMatchObject({
			running: true,
			services: {
				compiler: { owner: null, status: "starting" },
				rojo: {
					exitCode: 3,
					outputTail: ["-first-", "last"],
					owner: null,
					status: "failed",
				},
			},
		});
		expect(calls).not.toContainEqual(expect.stringMatching(/^terminate/));
		expect(run.reporter.events).toContainEqual({
			message: `rojo exited (exit code 3); the session goes on without it. Its output is in ${path.join(PROJECT, ".forge", "logs", "rojo.log")}.`,
			type: "warning",
		});
		await expect(run.result).resolves.toMatchObject({ data: { reason: "SIGINT" } });
	});

	it("should keep only the last lines of a failed service's output", async () => {
		expect.assertions(1);

		const run = startCommand();
		await flushAsync();
		const lines = Array.from({ length: PART_TAIL_LINES + 5 }, (_, index) => `line ${index}`);
		run.memory.fileSystem.writeFileSync(
			path.join(SESSION, "output", "rojo.log"),
			`${lines.join("\n")}\n`,
		);
		run.fake.exit("rojo", EXITED);
		await passAsync(run, OUTPUT_POLL_MS);
		const state = stateOf(run);
		run.signals.fire("SIGINT");
		await run.result;

		expect(state).toMatchObject({
			services: { rojo: { outputTail: lines.slice(-PART_TAIL_LINES) } },
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

	it("should stop Rojo as failed when it never listens within the bound, and go on", async () => {
		expect.assertions(5);

		const run = startCommand({ isListening: async () => false });
		await flushAsync();
		await passAsync(run, ROJO_LISTEN_BOUND_MS);
		const stopped = [...run.fake.calls];
		run.fake.exit("rojo", { ...EXITED, exitCode: null });
		await passAsync(run, OUTPUT_POLL_MS);
		const state = stateOf(run);
		run.signals.fire("SIGINT");

		expect(stopped.at(-1)).toBe("stop rojo 3000");
		expect(state).toMatchObject({
			phase: "ready",
			running: true,
			services: { rojo: { exitCode: null, outputTail: [], status: "failed" } },
		});
		expect(run.reporter.events).toContainEqual({
			message: `rojo did not listen on port 4000 within 60 s; the session goes on without it. Its output is in ${path.join(PROJECT, ".forge", "logs", "rojo.log")}.`,
			type: "warning",
		});
		expect(run.reporter.events).toContainEqual({
			message: "Press Ctrl+C to stop.",
			type: "info",
		});
		await expect(run.result).resolves.toMatchObject({ data: { reason: "SIGINT" } });
	});

	it("should stop waiting for Rojo to listen once it exits, and announce the compiler alone", async () => {
		expect.assertions(2);

		const run = startCommand({
			file: { luau: { watch: { command: "darklua" } } },
			files: { ...TOOL_FILES, "tools/darklua": "" },
			flags: { open: false },
			isListening: async () => false,
		});
		await flushAsync();
		run.fake.exit("rojo", EXITED);
		await passAsync(run, OUTPUT_POLL_MS);
		const checks = run.isListeningAsync.mock.calls.length;
		await passAsync(run, 4 * OUTPUT_POLL_MS);
		run.signals.fire("SIGINT");
		await run.result;

		expect(run.isListeningAsync).toHaveBeenCalledTimes(checks);
		expect(run.reporter.events).toContainEqual({
			message: "The compiler watches your code. Press Ctrl+C to stop.",
			type: "info",
		});
	});

	it("should not report Rojo ready when it exited while its port was checked", async () => {
		expect.assertions(2);

		const listening = Promise.withResolvers<boolean>();
		const run = startCommand({ isListening: async () => listening.promise });
		await flushAsync();
		run.fake.exit("rojo", EXITED);
		await passAsync(run, OUTPUT_POLL_MS);
		listening.resolve(true);
		await flushAsync();
		await passAsync(run, OUTPUT_POLL_MS);
		const state = stateOf(run);
		run.signals.fire("SIGINT");
		await run.result;

		expect(state).toMatchObject({ services: { rojo: { status: "failed" } } });
		expect(run.reporter.events).toContainEqual({
			message: "Press Ctrl+C to stop.",
			type: "info",
		});
	});

	it("should mark only the compiler failed when it exits, and keep Rojo serving", async () => {
		expect.assertions(2);

		const run = startCommand({ flags: { open: false }, projectType: "rbxts" });
		await flushAsync();
		run.fake.exit("compiler", EXITED);
		await passAsync(run, OUTPUT_POLL_MS);
		const state = stateOf(run);
		run.signals.fire("SIGINT");

		expect(state).toMatchObject({
			phase: "ready",
			running: true,
			services: {
				compiler: { exitCode: 3, owner: null, status: "failed" },
				rojo: { owner: null, status: "ready" },
			},
		});
		await expect(run.result).resolves.toMatchObject({ data: { reason: "SIGINT" } });
	});

	it.for([
		[{ exitCode: null, signal: 9 }, "rojo exited (signal 9)"],
		[{ exitCode: null, signal: null }, "rojo exited (killed)"],
	] as const)("should describe an exit of %o", async ([exit, why]) => {
		expect.assertions(1);

		const run = startCommand();
		await flushAsync();
		run.fake.exit("rojo", { ...EXITED, ...exit });
		await passAsync(run, OUTPUT_POLL_MS);
		run.signals.fire("SIGINT");
		await run.result;

		expect(run.reporter.events).toContainEqual({
			message: `${why}; the session goes on without it. Its output is in ${path.join(PROJECT, ".forge", "logs", "rojo.log")}.`,
			type: "warning",
		});
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
			message: "Rojo port 4000 is in use.",
		});
		expect(run.isPortFreeAsync).toHaveBeenCalledExactlyOnceWith(4000);
		expect(run.fake.launches).toStrictEqual([]);
	});

	it("should serve Rojo on a free port when none is set and the default port is busy", async () => {
		expect.assertions(2);

		const run = await stoppedAsync({ isPortFree: false, rojoPort: "unset" });

		await expect(run.result).resolves.toMatchObject({ data: { port: FREE_PORT } });
		expect(spawnedIds(run.fake)).toStrictEqual([
			`rojo: serve default.project.json --port ${FREE_PORT}`,
		]);
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
		run.signals.fire("SIGINT");

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
				compiler: { building: false, owner: null, status: "off" },
				rojo: { owner: null, port: 4000, status: "ready" },
				studio: { owner: null, status: "off" },
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
					building: false,
					lastBuild: {
						at: "2026-01-01T00:00:00.250Z",
						diagnostics: [{ code: "TS2322", file: "src/a.ts", line: 3 }],
						errors: 1,
						startedAt: "2026-01-01T00:00:00.250Z",
					},
					status: "ready",
				},
			},
		});
	});

	it("should show in state.json while a compile runs", async () => {
		expect.assertions(1);

		const run = startCommand({ flags: { open: false }, projectType: "rbxts" });
		await flushAsync();
		run.memory.fileSystem.writeFileSync(
			path.join(SESSION, "output", "compiler.log"),
			"[10:00:00] Starting compilation in watch mode...\n",
		);
		await passAsync(run, OUTPUT_POLL_MS);

		expect(stateOf(run)).toMatchObject({
			phase: "starting",
			services: { compiler: { building: true, status: "starting" } },
		});
	});

	it("should answer freshStatus at once for a Luau watch command, which reports no builds", async () => {
		expect.assertions(1);

		const run = startCommand({
			file: { luau: { watch: { command: "darklua" } } },
			files: { ...TOOL_FILES, "tools/darklua": "" },
			flags: { open: false },
		});
		await flushAsync();
		const waiting = callSessionAsync(run.ipc, CONTROL_TARGET, "freshStatus", {
			params: { timeoutMs: 1 },
		});
		await flushAsync();
		run.clock.advance(1);

		await expect(waiting).resolves.toMatchObject({
			services: { compiler: { status: "ready" } },
		});
	});

	it("should wait in freshStatus for the first build of a roblox-ts compiler", async () => {
		expect.assertions(1);

		const run = startCommand({ flags: { open: false }, projectType: "rbxts" });
		await flushAsync();
		const waiting = callSessionAsync(run.ipc, CONTROL_TARGET, "freshStatus", {
			params: { timeoutMs: 1 },
		});
		await flushAsync();
		run.clock.advance(1);

		await expect(waiting).rejects.toMatchObject({ code: "compile_timeout" });
	});

	it("should fail a freshStatus wait with service_failed when the compiler exits", async () => {
		expect.assertions(1);

		const run = startCommand({ flags: { open: false }, projectType: "rbxts" });
		run.result.catch(() => {});
		await flushAsync();
		const waiting = callSessionAsync(run.ipc, CONTROL_TARGET, "freshStatus", {
			params: { timeoutMs: 60_000 },
			responseTimeoutMs: 10_000,
		});
		await flushAsync();
		run.fake.exit("compiler", EXITED);

		await expect(waiting).rejects.toMatchObject({
			code: "service_failed",
			details: { reason: "service_failed:compiler" },
			hint: `Its output is in ${path.join(PROJECT, ".forge", "logs", "compiler.log")}.`,
			message: "The compiler stopped, so no build comes.",
		});
	});

	it("should fail a freshStatus wait with not_running once the session stops", async () => {
		expect.assertions(1);

		const run = startCommand({ flags: { open: false }, projectType: "rbxts" });
		await flushAsync();
		const waiting = callSessionAsync(run.ipc, CONTROL_TARGET, "freshStatus", {
			params: { timeoutMs: 60_000 },
			responseTimeoutMs: 10_000,
		});
		await flushAsync();
		run.signals.fire("SIGINT");
		await run.result;

		await expect(waiting).rejects.toMatchObject({
			code: "not_running",
			hint: 'Start a session with "forge up".',
			message: "The session is stopping; no build comes.",
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

		expect(open).toMatchObject({
			phase: "ready",
			services: { studio: { place: PLACE, status: "open" } },
		});
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
/** What `forge up` asks for: the compiler, no Studio, no Rojo. */
const UP: FlagValues = { open: false, rojo: false };
const ADD_CALL = { params: { parts: ["compiler"] }, responseTimeoutMs: 60_000 };

/**
 * Ask the session to add the compiler.
 *
 * @param run - The session.
 * @returns The answer, or the failure it rejected with.
 */
async function addCompilerAsync(run: StartRun): Promise<unknown> {
	const answer = callSessionAsync(run.ipc, CONTROL_TARGET, "addParts", ADD_CALL).catch(
		(err: unknown) => err,
	);
	await passAsync(run, OUTPUT_POLL_MS);
	return answer;
}

/**
 * Ask the session for a fresh build within 1 ms.
 *
 * @param run - The session.
 * @returns The failure it rejected with, or its answer.
 */
async function freshWithinAsync(run: StartRun): Promise<unknown> {
	const waiting = callSessionAsync(run.ipc, CONTROL_TARGET, "freshStatus", {
		params: { timeoutMs: 1 },
	}).catch((err: unknown) => err);
	await flushAsync();
	run.clock.advance(1);
	return waiting;
}

describe("forge up parts", () => {
	it("should start only the compiler for up: no compile or build step, no Rojo, no port", async () => {
		expect.assertions(4);

		const run = startCommand({ flags: UP, projectType: "rbxts" });
		await flushAsync();
		const state = stateOf(run);
		run.signals.fire("SIGINT");
		const result = await run.result;

		expect(spawnedIds(run.fake)).toStrictEqual(["compiler: -w"]);
		expect(run.isPortFreeAsync).not.toHaveBeenCalled();
		expect(state).toMatchObject({
			phase: "starting",
			services: {
				compiler: { status: "starting" },
				rojo: { owner: null, status: "off" },
				studio: { status: "off" },
			},
		});
		expect(result.data).not.toHaveProperty("port");
	});

	it("should be ready at once with no part in a Luau project with no watch command", async () => {
		expect.assertions(3);

		const onReady = vi.fn<() => void>();
		const run = startCommand({ flags: UP, onReady });
		await flushAsync();
		const state = stateOf(run);
		const fresh = await freshWithinAsync(run);
		run.signals.fire("SIGINT");
		await run.result;

		expect(state).toMatchObject({
			phase: "ready",
			services: { compiler: { status: "off" }, rojo: { status: "off" } },
		});
		expect(fresh).toMatchObject({ services: { compiler: { status: "off" } } });
		expect(onReady).toHaveBeenCalledOnce();
	});

	it("should start the compiler again once it failed, and wait for its new first build", async () => {
		expect.assertions(4);

		const run = startCommand({ flags: UP, projectType: "rbxts" });
		await flushAsync();
		run.fake.exit("compiler", EXITED);
		await passAsync(run, OUTPUT_POLL_MS);
		const answer = await addCompilerAsync(run);
		const state = stateOf(run);
		const fresh = await freshWithinAsync(run);
		run.signals.fire("SIGINT");
		await run.result;

		expect(answer).toStrictEqual({ added: ["compiler"] });
		expect(spawnedIds(run.fake)).toStrictEqual(["compiler: -w", "compiler: -w"]);
		expect(state).toMatchObject({
			phase: "starting",
			services: { compiler: { status: "starting" } },
		});
		// The failure of the compiler before is gone: the wait is for a build.
		expect(fresh).toMatchObject({ code: "compile_timeout" });
	});

	it("should read only the output of the compiler that runs now", async () => {
		expect.assertions(1);

		const run = startCommand({ flags: UP, projectType: "rbxts" });
		const spool = path.join(SESSION, "output", "compiler.log");
		await flushAsync();
		run.memory.fileSystem.writeFileSync(spool, "Found 3 errors. Watching for file changes.\n");
		await passAsync(run, OUTPUT_POLL_MS);
		run.fake.exit("compiler", EXITED);
		await passAsync(run, OUTPUT_POLL_MS);
		await addCompilerAsync(run);
		run.memory.fileSystem.writeFileSync(spool, "Found 0 errors. Watching for file changes.\n", {
			flag: "a",
		});
		await passAsync(run, OUTPUT_POLL_MS);
		const state = stateOf(run);
		run.signals.fire("SIGINT");
		await run.result;

		expect({
			compiled: run.reporter.events.filter(({ type }) => type === "compiled"),
			state,
		}).toMatchObject({
			compiled: [{ errors: 3 }, { errors: 0 }],
			state: {
				phase: "ready",
				services: { compiler: { lastBuild: { errors: 0 }, status: "ready" } },
			},
		});
	});

	it("should wait for the first build while the compile step runs, before the compiler", async () => {
		expect.assertions(1);

		const run = startCommand({
			flags: { open: false },
			oneShot: oneShotsWith({ "start-1": "hold" }),
			projectType: "rbxts",
		});
		await flushAsync();
		const fresh = await freshWithinAsync(run);
		run.signals.fire("SIGINT");
		await run.result.catch(ignoreFailure);

		expect(fresh).toMatchObject({ code: "compile_timeout" });
	});

	it("should add nothing while every part it asks for runs", async () => {
		expect.assertions(2);

		const run = startCommand({ flags: UP, projectType: "rbxts" });
		await flushAsync();
		const answer = await addCompilerAsync(run);
		run.signals.fire("SIGINT");
		await run.result;

		expect(answer).toStrictEqual({ added: [] });
		expect(spawnedIds(run.fake)).toStrictEqual(["compiler: -w"]);
	});

	it("should add the compiler to a session that started without it", async () => {
		expect.assertions(3);

		const run = startCommand({ projectType: "rbxts" });
		await flushAsync();
		const before = await freshWithinAsync(run);
		const answer = await addCompilerAsync(run);
		const after = await freshWithinAsync(run);
		run.signals.fire("SIGINT");
		await run.result;

		expect(answer).toStrictEqual({ added: ["compiler"] });
		expect(spawnedIds(run.fake)).toStrictEqual([
			"rojo: serve default.project.json --port 4000",
			"compiler: -w",
		]);
		expect([before, after]).toMatchObject([
			{ services: { compiler: { status: "off" } } },
			{ code: "compile_timeout" },
		]);
	});

	it("should add a Luau watch command, which is ready once it runs", async () => {
		expect.assertions(2);

		const run = startCommand({
			file: { luau: { watch: { command: "darklua" } } },
			files: { ...TOOL_FILES, "tools/darklua": "" },
			flags: { ...UP, compiler: false },
		});
		await flushAsync();
		const answer = await addCompilerAsync(run);
		const state = stateOf(run);
		run.signals.fire("SIGINT");
		await run.result;

		expect(answer).toStrictEqual({ added: ["compiler"] });
		expect(state).toMatchObject({
			phase: "ready",
			services: { compiler: { status: "ready" } },
		});
	});

	it("should add no compiler to a project that has none", async () => {
		expect.assertions(2);

		const run = startCommand({ flags: UP });
		await flushAsync();
		const answer = await addCompilerAsync(run);
		run.signals.fire("SIGINT");
		await run.result;

		expect(answer).toStrictEqual({ added: [] });
		expect(spawnedIds(run.fake)).toStrictEqual([]);
	});

	it("should fail with compiler_missing when the compiler is gone since the session started", async () => {
		expect.assertions(1);

		const run = startCommand({ flags: UP, projectType: "rbxts" });
		await flushAsync();
		run.fake.exit("compiler", EXITED);
		await passAsync(run, OUTPUT_POLL_MS);
		run.memory.fileSystem.rmSync(path.join(TOOLS, "rbxtsc"));
		const answer = await addCompilerAsync(run);
		run.signals.fire("SIGINT");
		await run.result;

		expect(answer).toMatchObject({ code: "compiler_missing" });
	});

	it("should answer not_running when the session stops before its parts started", async () => {
		expect.assertions(1);

		const run = startCommand({
			flags: { open: false },
			oneShot: oneShotsWith({ "start-1": "hold" }),
			projectType: "rbxts",
		});
		await flushAsync();
		const answer = callSessionAsync(run.ipc, CONTROL_TARGET, "addParts", ADD_CALL);
		await flushAsync();
		run.signals.fire("SIGINT");
		await run.result.catch(ignoreFailure);

		await expect(answer).rejects.toMatchObject({ code: "not_running" });
	});
});

/** The Studio the session launches for an attach. */
const LAUNCHED_PID = 900;
const LAUNCHED_LOCK = `${LAUNCHED_PID}\nRobloxStudioBeta\n${TEST_HOSTNAME}\n`;
const STUDIO = { parts: ["studio"] };

/**
 * Ask the session to add parts, with no bound the test reaches.
 *
 * @param run - The session.
 * @param parameters - The request's params.
 * @returns The answer, or the failure it rejected with.
 */
async function askAddAsync(run: StartRun, parameters: Record<string, unknown>): Promise<unknown> {
	return callSessionAsync(run.ipc, CONTROL_TARGET, "addParts", {
		params: parameters,
		responseTimeoutMs: 600_000,
	}).catch((err: unknown) => err);
}

/**
 * Ask the session to attach Studio, and let the launched Studio open the
 * place.
 *
 * @param run - The session; its launcher starts Studio {@link LAUNCHED_PID}.
 * @param parameters - The request's params.
 * @returns The answer, or the failure it rejected with.
 */
async function attachAsync(
	run: StartRun,
	parameters: Record<string, unknown> = STUDIO,
): Promise<unknown> {
	run.studioLauncher.mockResolvedValue({
		studio: { pid: LAUNCHED_PID, startTime: "900" },
		type: "launched",
	});
	const answer = askAddAsync(run, parameters);
	await passAsync(run, FILE_POLL_MS);
	run.memory.fileSystem.writeFileSync(LOCK, LAUNCHED_LOCK);
	await passAsync(run, FILE_POLL_MS);
	return answer;
}

describe("forge up --studio", () => {
	it("should build the place, open Studio, and serve Rojo, then answer once both are ready", async () => {
		expect.assertions(4);

		const run = startCommand({ flags: UP });
		await flushAsync();
		const answer = await attachAsync(run, { parts: ["studio"], studioPath: "/opt/Studio" });
		const state = stateOf(run);
		run.signals.fire("SIGINT");
		await run.result;

		expect(answer).toStrictEqual({ added: ["studio", "rojo"] });
		expect(spawnedIds(run.fake)).toStrictEqual([
			"start-1: build default.project.json --output game.rbxl",
			"rojo: serve default.project.json --port 4000",
		]);
		expect(run.studioLauncher).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ place: PLACE, studioPath: "/opt/Studio" }),
		);
		expect(state).toMatchObject({
			phase: "ready",
			services: {
				rojo: { owner: null, port: 4000, status: "ready" },
				studio: { owner: null, pid: LAUNCHED_PID, place: PLACE, status: "open" },
			},
		});
	});

	it("should attach the Studio that has the place open: no build, no launch", async () => {
		expect.assertions(3);

		const run = startCommand({
			files: { ...TOOL_FILES, "game.rbxl.lock": STUDIO_LOCK },
			flags: UP,
			processes: OPEN_STUDIO,
		});
		await flushAsync();
		const answer = askAddAsync(run, STUDIO);
		await passAsync(run, FILE_POLL_MS);
		run.signals.fire("SIGINT");
		await run.result;

		await expect(answer).resolves.toStrictEqual({ added: ["studio", "rojo"] });
		expect(spawnedIds(run.fake)).toStrictEqual([
			"rojo: serve default.project.json --port 4000",
		]);
		expect(run.studioLauncher).not.toHaveBeenCalled();
	});

	it("should wait for the compiler's fresh build before it builds the place", async () => {
		expect.assertions(2);

		const run = startCommand({ flags: UP, projectType: "rbxts" });
		await flushAsync();
		const answer = attachAsync(run, { parts: ["compiler", "studio"] });
		await passAsync(run, OUTPUT_POLL_MS);
		const beforeBuild = spawnedIds(run.fake);
		run.memory.fileSystem.writeFileSync(
			path.join(SESSION, "output", "compiler.log"),
			"Found 0 errors. Watching for file changes.\n",
		);
		await passAsync(run, 2 * FILE_POLL_MS);
		run.memory.fileSystem.writeFileSync(LOCK, LAUNCHED_LOCK);
		await passAsync(run, FILE_POLL_MS);
		run.signals.fire("SIGINT");
		await run.result;

		expect(beforeBuild).toStrictEqual(["compiler: -w"]);
		await expect(answer).resolves.toStrictEqual({ added: ["studio", "rojo"] });
	});

	it("should fail with port_in_use before Studio opens when the set port is busy", async () => {
		expect.assertions(3);

		const run = startCommand({ flags: UP, isPortFree: false });
		await flushAsync();
		const answer = await askAddAsync(run, STUDIO);
		const state = stateOf(run);
		run.signals.fire("SIGINT");
		await run.result;

		expect(answer).toMatchObject({ code: "port_in_use", message: "Rojo port 4000 is in use." });
		expect([spawnedIds(run.fake), run.studioLauncher.mock.calls]).toStrictEqual([[], []]);
		expect(state).toMatchObject({ services: { studio: { status: "off" } } });
	});

	it("should take a free port when none is set, and keep it when Rojo starts again", async () => {
		expect.assertions(3);

		const run = startCommand({ flags: UP, isPortFree: false, rojoPort: "unset" });
		await flushAsync();
		const first = await attachAsync(run);
		run.fake.exit("rojo", EXITED);
		await passAsync(run, OUTPUT_POLL_MS);
		const repair = await askAddAsync(run, { parts: [] });
		run.signals.fire("SIGINT");
		const result = await run.result;

		expect([first, repair]).toStrictEqual([{ added: ["studio", "rojo"] }, { added: ["rojo"] }]);
		expect(spawnedIds(run.fake).filter((id) => id.startsWith("rojo"))).toStrictEqual([
			`rojo: serve default.project.json --port ${FREE_PORT}`,
			`rojo: serve default.project.json --port ${FREE_PORT}`,
		]);
		expect(result.data).toMatchObject({ port: FREE_PORT });
	});

	it("should add nothing while Studio and its Rojo run", async () => {
		expect.assertions(2);

		const run = startCommand({ flags: UP });
		await flushAsync();
		await attachAsync(run);
		const again = await askAddAsync(run, STUDIO);
		run.signals.fire("SIGINT");
		await run.result;

		expect(again).toStrictEqual({ added: [] });
		expect(run.studioLauncher).toHaveBeenCalledOnce();
	});

	it("should stop only Rojo when the attached Studio closes, and attach again later", async () => {
		expect.assertions(4);

		const run = startCommand({
			file: { luau: { watch: { command: "darklua" } } },
			files: { ...TOOL_FILES, "tools/darklua": "" },
			flags: UP,
		});
		await flushAsync();
		await attachAsync(run);
		run.memory.fileSystem.rmSync(LOCK);
		await passAsync(run, FILE_POLL_MS);
		const stopCalls = run.fake.calls.filter((call) => call.startsWith("stop "));
		run.fake.exit("rojo", OK);
		await passAsync(run, OUTPUT_POLL_MS);
		const closed = stateOf(run);
		const again = await attachAsync(run);
		run.signals.fire("SIGINT");

		expect(stopCalls).toStrictEqual(["stop rojo 3000"]);
		expect(closed).toMatchObject({
			phase: "ready",
			services: {
				compiler: { status: "ready" },
				rojo: { port: 4000, status: "off" },
				studio: { status: "closed" },
			},
		});
		expect(again).toStrictEqual({ added: ["studio", "rojo"] });
		await expect(run.result).resolves.toMatchObject({ data: { reason: "SIGINT" } });
	});

	it("should say that the attached Studio has the place open", async () => {
		expect.assertions(1);

		const run = startCommand({ flags: UP });
		await flushAsync();
		await attachAsync(run);
		run.signals.fire("SIGINT");
		await run.result;

		expect(run.reporter.events).toContainEqual({
			message: `Roblox Studio has ${PLACE} open.`,
			type: "info",
		});
	});

	it("should attach Studio to a session whose Rojo runs, and start no second Rojo", async () => {
		expect.assertions(2);

		const run = startCommand();
		await flushAsync();
		const answer = await attachAsync(run);
		run.signals.fire("SIGINT");
		await run.result;

		expect(answer).toStrictEqual({ added: ["studio"] });
		expect(spawnedIds(run.fake).filter((id) => id.startsWith("rojo"))).toHaveLength(1);
	});

	it("should fail with studio_launch_failed when Studio does not open the place in time", async () => {
		expect.assertions(2);

		const run = startCommand({ flags: UP });
		await flushAsync();
		const answer = askAddAsync(run, STUDIO);
		await passAsync(run, STUDIO_OPEN_BOUND_MS + FILE_POLL_MS);
		const state = stateOf(run);
		run.signals.fire("SIGINT");
		await run.result;

		await expect(answer).resolves.toMatchObject({
			code: "studio_launch_failed",
			hint: 'The session keeps waiting for it; check "forge status".',
			message: `Roblox Studio did not open ${PLACE} within 180 s.`,
		});
		expect(state).toMatchObject({
			services: { rojo: { status: "ready" }, studio: { status: "opening" } },
		});
	});

	it("should open no second Studio for a session that opened its own", async () => {
		expect.assertions(2);

		const run = startCommand({ flags: { compiler: false } });
		await flushAsync();
		const answer = await askAddAsync(run, STUDIO);
		run.signals.fire("SIGINT");
		await run.result;

		expect(answer).toStrictEqual({ added: [] });
		expect(run.studioLauncher).toHaveBeenCalledOnce();
	});

	it("should attach Studio while a failed compiler stays failed", async () => {
		expect.assertions(1);

		const run = startCommand({ flags: UP, projectType: "rbxts" });
		await flushAsync();
		run.fake.exit("compiler", EXITED);
		await passAsync(run, OUTPUT_POLL_MS);
		const answer = await attachAsync(run);
		run.signals.fire("SIGINT");
		await run.result;

		expect(answer).toStrictEqual({ added: ["studio", "rojo"] });
	});

	it("should start an up session with no Rojo installed, and fail with rojo_missing on attach", async () => {
		expect.assertions(2);

		const run = startCommand({
			files: { "tools/rbxtsc": "" },
			flags: UP,
			projectType: "rbxts",
		});
		await flushAsync();
		const answer = await askAddAsync(run, STUDIO);
		run.signals.fire("SIGINT");
		await run.result;

		expect(answer).toMatchObject({ code: "rojo_missing" });
		expect(run.studioLauncher).not.toHaveBeenCalled();
	});

	it("should answer at once when the session stops while Studio opens", async () => {
		expect.assertions(1);

		const run = startCommand({ flags: UP });
		await flushAsync();
		const answer = askAddAsync(run, STUDIO);
		await passAsync(run, FILE_POLL_MS);
		run.signals.fire("SIGINT");
		let isAnswered = false;
		void answer.finally(() => {
			isAnswered = true;
		});
		await passAsync(run, FILE_POLL_MS);
		await run.result;

		expect(isAnswered).toBeTrue();
	});

	it("should leave the attached Studio open when the session stops", async () => {
		expect.assertions(1);

		const run = startCommand({ flags: UP });
		await flushAsync();
		await attachAsync(run);
		run.native.addon.tryLockFile(path.join(SESSION, "workers.lock"), "shared");
		run.signals.fire("SIGINT");
		const caught = run.result.catch((err: unknown) => err);
		await passAsync(run, 5250);
		await caught;

		expect(stateOf(run)).toMatchObject({
			phase: "stopping",
			services: { studio: { status: "open" } },
		});
	});

	it("should open no Studio and start no Rojo once the session stops during the build", async () => {
		expect.assertions(2);

		const run: StartRun = startCommand({
			file: { luau: { watch: { command: "darklua" } } },
			files: { ...TOOL_FILES, "tools/darklua": "" },
			flags: UP,
			reaper: {
				onSpawn: onSpawnOf("start-1", () => {
					run.signals.fire("SIGINT");
				}),
			},
		});
		await flushAsync();
		const answer = askAddAsync(run, STUDIO);
		await run.result;

		await expect(answer).resolves.toBeDefined();
		expect([run.studioLauncher.mock.calls, spawnedIds(run.fake)]).toStrictEqual([
			[],
			["compiler: ", "start-1: build default.project.json --output game.rbxl"],
		]);
	});
});

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

/** A Luau project whose watch command is ready once it runs. */
const WATCH: StartSetup = {
	file: { luau: { watch: { command: "darklua" } } },
	files: { ...TOOL_FILES, "tools/darklua": "" },
};
const OWN_CALL = { params: { parts: ["compiler"] }, responseTimeoutMs: 600_000 };

/**
 * Join the session as a `start` does, and keep the connection.
 *
 * @param run - The session.
 * @param parts - The parts the join asks for.
 * @returns The held session, or the failure the join rejected with.
 */
async function joinAsync(
	run: StartRun,
	parts: ReadonlyArray<string> = ["compiler"],
): Promise<OwnedSession> {
	const staying = new AbortController();
	const joined = ownSessionAsync(run.ipc, CONTROL_TARGET, {
		params: { parts },
		responseTimeoutMs: 600_000,
		signal: staying.signal,
	});
	// A failed join rejects there; only a held one is waited for here.
	joined.catch(ignoreFailure);
	await passAsync(run, OUTPUT_POLL_MS);
	const owned = await joined;
	assert(owned !== undefined, "the join was not given up");
	return owned;
}

/**
 * A pause that ends the owner at one point, once the run exists.
 *
 * @param point - Where the owner goes.
 * @param run - The run, once made.
 * @returns The pause.
 */
function ownerGoneAt(point: PausePoint, run: () => StartRun): Pause {
	return async (at) => {
		// The run is made first.
		await flushAsync();
		if (at === point) {
			run().owner.request({ type: "owner_gone" });
		}
	};
}

/**
 * Let go of a held session, and wait for the answer.
 *
 * @param owned - The held session.
 * @param run - The session, whose time passes meanwhile.
 * @param exits - The services the release stops, which exit once asked.
 * @returns The release's answer.
 */
async function letGoAsync(
	owned: OwnedSession,
	run: StartRun,
	exits: ReadonlyArray<string> = [],
): Promise<unknown> {
	const release = new AbortController();
	const held = owned.holdAsync(release.signal, 600_000);
	release.abort();
	for (const id of exits) {
		await vi.waitFor(() => {
			assert(run.fake.calls.includes(`stop ${id} 3000`), `${id} is asked to stop`);
		});
		run.fake.exit(id, OK);
		await passAsync(run, OUTPUT_POLL_MS);
	}

	return held;
}

describe("forge down control channel", () => {
	it("should close the session's Studio, stop Rojo, and end once syncback settled", async () => {
		expect.assertions(2);

		const run: StartRun = startCommand({
			flags: { compiler: false },
			processes: {
				[LAUNCHED_PID]: {
					alive: true,
					executablePath: "/opt/RobloxStudio",
					onClose: () => {
						run.memory.fileSystem.rmSync(LOCK);
					},
					startTime: "900",
				},
			},
		});
		run.studioLauncher.mockResolvedValue({
			studio: { pid: LAUNCHED_PID, startTime: "900" },
			type: "launched",
		});
		await flushAsync();
		run.memory.fileSystem.writeFileSync(LOCK, LAUNCHED_LOCK);
		await passAsync(run, FILE_POLL_MS);
		const answer = callSessionAsync(run.ipc, CONTROL_TARGET, "stopParts", {
			params: { scope: "down" },
			responseTimeoutMs: 600_000,
		});
		await vi.waitFor(async () => {
			await passAsync(run, OUTPUT_POLL_MS);
			assert(run.fake.calls.includes("stop rojo 3000"), "Rojo is asked to stop");
		});
		run.fake.exit("rojo", OK);
		await passAsync(run, OUTPUT_POLL_MS);

		await expect(answer).resolves.toMatchObject({ ending: true, stopped: ["studio", "rojo"] });
		await expect(run.result).resolves.toMatchObject({ data: { reason: "shutdown" } });
	});
});

describe("forge down and syncback", () => {
	it("should sync back a save Studio made just before a down closed it, then end", async () => {
		expect.assertions(2);

		const run: StartRun = startCommand({
			...SYNCBACK,
			files: { ...TOOL_FILES, "game.rbxl": "v1" },
			flags: { compiler: false, syncback: true },
			// Rojo listens on the second look: the save watch looks 100 ms
			// after the Studio watch.
			isListening: vi
				.fn<Network["isListeningAsync"]>()
				.mockResolvedValueOnce(false)
				.mockResolvedValue(true),
			processes: {
				[LAUNCHED_PID]: {
					alive: true,
					executablePath: "/opt/RobloxStudio",
					onClose: () => {
						run.memory.fileSystem.rmSync(LOCK);
					},
					startTime: "900",
				},
			},
		});
		run.studioLauncher.mockResolvedValue({
			studio: { pid: LAUNCHED_PID, startTime: "900" },
			type: "launched",
		});
		await flushAsync();
		run.clock.advance(100);
		await flushAsync();
		run.memory.fileSystem.writeFileSync(LOCK, LAUNCHED_LOCK);
		run.clock.advance(400);
		await flushAsync();
		run.clock.advance(100);
		await flushAsync();
		// Studio saves the place, and a down closes it before the save watch
		// looks.
		run.memory.setModifiedTime("game.rbxl", Date.UTC(2026, 0, 2));
		const answer = callSessionAsync(run.ipc, CONTROL_TARGET, "stopParts", {
			params: { scope: "down" },
			responseTimeoutMs: 600_000,
		});
		await vi.waitFor(async () => {
			run.clock.advance(10);
			await flushAsync();
			assert(run.fake.calls.includes("stop rojo 3000"), "Rojo is asked to stop");
		});
		run.fake.exit("rojo", OK);
		await passAsync(run, OUTPUT_POLL_MS);

		await expect(answer).resolves.toMatchObject({ ending: true });
		expect(spawnedIds(run.fake)).toContain(
			"syncback-1: syncback default.project.json --input game.rbxl --non-interactive",
		);
	});
});

describe("forge start owners", () => {
	it("should give its owner every part it starts with, and end as before once it goes", async () => {
		expect.assertions(3);

		const run = startCommand({ owned: true });
		await flushAsync();
		const owned = stateOf(run);
		run.owner.request({ signal: "SIGINT", type: "signal" });

		expect(owned).toMatchObject({
			services: {
				compiler: { owner: null, status: "off" },
				rojo: { owner: "start", status: "ready" },
				studio: { owner: null, status: "off" },
			},
		});
		await expect(run.result).resolves.toMatchObject({ data: { reason: "SIGINT" } });
		expect(run.onReleased).not.toHaveBeenCalled();
	});

	it("should stop the whole session when its owner goes before the parts started", async () => {
		expect.assertions(2);

		const run = startCommand({
			flags: { open: false },
			oneShot: oneShotsWith({ "start-1": "hold" }),
			owned: true,
			projectType: "rbxts",
		});
		await flushAsync();
		run.owner.request({ type: "owner_gone" });

		await expect(run.result).resolves.toMatchObject({ data: { reason: "owner_gone" } });
		expect(run.fake.calls).toStrictEqual(["go", "spawn start-1", "terminate 3000"]);
	});

	it("should start nothing when its owner goes before the session opened", async () => {
		expect.assertions(1);

		const run = startCommand({
			owned: true,
			pause: () => ownerGoneAt("created", () => run),
		});

		await expect(run.result).resolves.toStrictEqual({
			data: { reason: "owner_gone", reports: [] },
			summary: "Stopped on owner_gone before the session started; nothing ran.",
		});
	});

	it("should stop what its owner started and run on with a part up added, once it goes", async () => {
		expect.assertions(3);

		const run = startCommand({ ...WATCH, owned: true });
		await flushAsync();
		await addCompilerAsync(run);
		run.owner.request({ signal: "SIGINT", type: "signal" });
		await passAsync(run, OUTPUT_POLL_MS);
		run.fake.exit("rojo", OK);
		await passAsync(run, OUTPUT_POLL_MS);
		const released = stateOf(run);
		run.signals.fire("SIGINT");
		await run.result;

		expect(released).toMatchObject({
			phase: "ready",
			services: {
				compiler: { owner: null, status: "ready" },
				rojo: { owner: null, status: "off" },
			},
		});
		expect(run.onReleased).toHaveBeenCalledExactlyOnceWith({
			data: {
				ending: false,
				released: [],
				sessionId: "session-1",
				stopped: ["rojo"],
				studioLeft: false,
			},
			summary: "Let go of session session-1: stopped Rojo.",
		});
		expect(run.fake.calls).toContain("stop rojo 3000");
	});

	it("should give no owner to a part that up started again after it failed", async () => {
		expect.assertions(2);

		const run = startCommand({ ...WATCH, flags: { open: false }, owned: true });
		await flushAsync();
		run.fake.exit("compiler", EXITED);
		await passAsync(run, OUTPUT_POLL_MS);
		const failed = stateOf(run);
		await addCompilerAsync(run);
		const repaired = stateOf(run);
		run.signals.fire("SIGINT");
		await run.result;

		expect(failed).toMatchObject({
			services: { compiler: { owner: "start", status: "failed" } },
		});
		expect(repaired).toMatchObject({
			services: {
				compiler: { owner: null, status: "ready" },
				rojo: { owner: "start", status: "ready" },
			},
		});
	});

	it("should refuse a start that joins while its own start owns it", async () => {
		expect.assertions(1);

		const run = startCommand({ owned: true });
		await flushAsync();
		const answer = await joinAsync(run).catch((err: unknown) => err);
		run.signals.fire("SIGINT");
		await run.result;

		expect(answer).toMatchObject({
			code: "session_running",
			hint: 'Stop that forge start first, or use "forge up".',
			message: "Session session-1 already has an owner: a forge start terminal.",
		});
	});

	it("should let a start join and take the running parts, and give them back once it lets go", async () => {
		expect.assertions(4);

		const run = startCommand({ ...WATCH, flags: UP });
		await flushAsync();
		const owned = await joinAsync(run);
		const taken = stateOf(run);
		const second = await joinAsync(run).catch((err: unknown) => err);
		const answer = await letGoAsync(owned, run);
		const released = stateOf(run);
		run.signals.fire("SIGINT");
		await run.result;

		expect(owned.joined).toStrictEqual({
			added: [],
			sessionId: "session-1",
			taken: ["compiler"],
		});
		expect([taken, released]).toMatchObject([
			{ services: { compiler: { owner: "start", status: "ready" } } },
			{ phase: "ready", services: { compiler: { owner: null, status: "ready" } } },
		]);
		expect(second).toMatchObject({ code: "session_running" });
		expect(answer).toStrictEqual({
			ending: false,
			released: ["compiler"],
			sessionId: "session-1",
			stopped: [],
			studioLeft: false,
		});
	});

	it("should stop what a joined start added once its connection ends, and end a session left with no part", async () => {
		expect.assertions(2);

		const run = startCommand({ ...WATCH, flags: { ...UP, compiler: false } });
		await flushAsync();
		const answer = await callSessionAsync(run.ipc, CONTROL_TARGET, "own", OWN_CALL);

		expect(answer).toStrictEqual({ added: ["compiler"], sessionId: "session-1", taken: [] });
		await expect(run.result).resolves.toMatchObject({ data: { reason: "owner_gone" } });
	});

	it("should leave open the Studio a joined start opened, and stop the Rojo it started", async () => {
		expect.assertions(5);

		const run = startCommand({ ...WATCH, flags: UP });
		await flushAsync();
		run.studioLauncher.mockResolvedValue({
			studio: { pid: LAUNCHED_PID, startTime: "900" },
			type: "launched",
		});
		const joining = joinAsync(run, ["compiler", "studio"]);
		await passAsync(run, FILE_POLL_MS);
		run.memory.fileSystem.writeFileSync(LOCK, LAUNCHED_LOCK);
		await passAsync(run, FILE_POLL_MS);
		const owned = await joining;
		const answer = await letGoAsync(owned, run, ["rojo"]);
		const left = stateOf(run);
		run.memory.fileSystem.rmSync(LOCK);
		await passAsync(run, FILE_POLL_MS);
		const closed = stateOf(run);
		// With no Studio left, a down that stops the compiler ends the session.
		const down = callSessionAsync(run.ipc, CONTROL_TARGET, "stopParts", {
			params: { scope: "down" },
			responseTimeoutMs: 600_000,
		});
		await vi.waitFor(async () => {
			await passAsync(run, OUTPUT_POLL_MS);
			assert(run.fake.calls.includes("stop compiler 3000"), "the compiler is asked to stop");
		});
		run.fake.exit("compiler", OK);
		await passAsync(run, OUTPUT_POLL_MS);

		await expect(down).resolves.toMatchObject({ ending: true, stopped: ["compiler"] });
		expect(owned.joined).toStrictEqual({
			added: ["studio", "rojo"],
			sessionId: "session-1",
			taken: ["compiler"],
		});
		expect(answer).toStrictEqual({
			ending: false,
			released: ["compiler"],
			sessionId: "session-1",
			stopped: ["rojo"],
			studioLeft: true,
		});
		expect(left).toMatchObject({
			phase: "ready",
			services: {
				compiler: { owner: null, status: "ready" },
				rojo: { owner: null, status: "off" },
				studio: { owner: null, status: "off" },
			},
		});
		// Its close later is no part of the session any more.
		expect(closed).toStrictEqual(left);
	});

	it("should give back what a join took when its add fails, and let the next start join", async () => {
		expect.assertions(3);

		const run = startCommand({ ...WATCH, flags: UP, isPortFree: false });
		await flushAsync();
		const failed = await joinAsync(run, ["compiler", "studio"]).catch((err: unknown) => err);
		const state = stateOf(run);
		const next = await joinAsync(run);
		run.signals.fire("SIGINT");
		await run.result;

		expect(failed).toMatchObject({ code: "port_in_use" });
		expect(state).toMatchObject({ services: { compiler: { owner: null, status: "ready" } } });
		expect(next.joined).toMatchObject({ taken: ["compiler"] });
	});
});

function ignoreFailure(): void {
	// The compile the stop cut short fails; only the sync answer matters.
}

const MINUTE_MS = 60_000;
/** An up session whose idle timeout is one minute. */
const IDLE_UP: StartSetup = { file: { session: { idleTimeout: 1 } }, flags: UP };

/**
 * Whether the run has ended, looked at later.
 *
 * @param run - The session.
 * @returns Reads whether it ended.
 */
function endedFlag(run: StartRun): () => boolean {
	let isEnded = false;
	void run.result.finally(() => {
		isEnded = true;
	});
	return () => isEnded;
}

/**
 * Let time pass in one step, then let what it woke settle.
 *
 * @param run - The session.
 * @param ms - How long.
 */
async function jumpAsync(run: StartRun, ms: number): Promise<void> {
	run.clock.advance(ms);
	await flushAsync();
	await flushAsync();
}

describe("idle timeout", () => {
	it("should stop the compiler with no owner and end the up session after the timeout", async () => {
		expect.assertions(3);

		const run = startCommand({ ...IDLE_UP, projectType: "rbxts" });
		await flushAsync();
		await jumpAsync(run, MINUTE_MS - 1);

		expect(run.fake.calls).not.toContain("stop compiler 3000");

		await jumpAsync(run, 1);
		run.fake.exit("compiler", OK);
		await passAsync(run, OUTPUT_POLL_MS);

		await expect(run.result).resolves.toMatchObject({ data: { reason: "shutdown" } });
		expect(run.reporter.events).toContainEqual({
			message: "No activity for 1 min: stopped compiler.",
			type: "info",
		});
	});

	it("should end an up session with no part after the timeout", async () => {
		expect.assertions(1);

		const run = startCommand(IDLE_UP);
		await flushAsync();
		await jumpAsync(run, MINUTE_MS);

		await expect(run.result).resolves.toMatchObject({ data: { reason: "shutdown" } });
	});

	it("should never stop the parts a start owns, nor end its session", async () => {
		expect.assertions(2);

		const run = startCommand({ ...IDLE_UP, owned: true, projectType: "rbxts" });
		const isEnded = endedFlag(run);
		await flushAsync();
		await jumpAsync(run, 10 * MINUTE_MS);
		const wasEnded = isEnded();
		run.owner.request({ signal: "SIGINT", type: "signal" });
		await run.result;

		expect(wasEnded).toBeFalse();
		expect(run.fake.calls).not.toContain("stop compiler 3000");
	});

	it("should wait 30 minutes by default", async () => {
		expect.assertions(2);

		const run = startCommand({ flags: UP });
		const isEnded = endedFlag(run);
		await flushAsync();
		await jumpAsync(run, 30 * MINUTE_MS - 1);

		expect(isEnded()).toBeFalse();

		await jumpAsync(run, 1);

		expect(isEnded()).toBeTrue();
	});

	it("should never stop with an idle timeout of 0", async () => {
		expect.assertions(1);

		const run = startCommand({ file: { session: { idleTimeout: 0 } }, flags: UP });
		const isEnded = endedFlag(run);
		await flushAsync();
		await jumpAsync(run, 1000 * MINUTE_MS);
		const wasEnded = isEnded();
		run.signals.fire("SIGINT");
		await run.result;

		expect(wasEnded).toBeFalse();
	});

	it("should start the time again on each client request", async () => {
		expect.assertions(2);

		const run = startCommand(IDLE_UP);
		const isEnded = endedFlag(run);
		await flushAsync();
		await jumpAsync(run, 50_000);
		await callSessionAsync(run.ipc, CONTROL_TARGET, "status");
		await jumpAsync(run, 50_000);

		expect(isEnded()).toBeFalse();

		await jumpAsync(run, 10_000);

		expect(isEnded()).toBeTrue();
	});

	it("should start the time again on each compile start", async () => {
		expect.assertions(2);

		const run = startCommand({ ...IDLE_UP, projectType: "rbxts" });
		await flushAsync();
		await jumpAsync(run, 50_000);
		run.memory.fileSystem.writeFileSync(
			path.join(SESSION, "output", "compiler.log"),
			"[10:00:00] Starting compilation in watch mode...\n",
		);
		await passAsync(run, OUTPUT_POLL_MS);
		await jumpAsync(run, 50_000);
		const before = [...run.fake.calls];
		await jumpAsync(run, 10_000);
		const after = [...run.fake.calls];
		run.signals.fire("SIGINT");
		await run.result;

		expect(before).not.toContain("stop compiler 3000");
		expect(after).toContain("stop compiler 3000");
	});

	it("should count no compile end as activity, such as the compiler's exit mid-compile", async () => {
		expect.assertions(1);

		const run = startCommand({ ...IDLE_UP, projectType: "rbxts" });
		const isEnded = endedFlag(run);
		await flushAsync();
		run.memory.fileSystem.writeFileSync(
			path.join(SESSION, "output", "compiler.log"),
			"[10:00:00] Starting compilation in watch mode...\n",
		);
		await passAsync(run, OUTPUT_POLL_MS);
		await jumpAsync(run, 50_000);
		run.fake.exit("compiler", EXITED);
		await passAsync(run, OUTPUT_POLL_MS);
		await jumpAsync(run, 10_000);

		expect(isEnded()).toBeTrue();
	});

	it("should count no write of the place once its Studio closed", async () => {
		expect.assertions(1);

		const run = startCommand({ ...IDLE_UP, files: { ...TOOL_FILES, "game.rbxl": "v1" } });
		const isEnded = endedFlag(run);
		await flushAsync();
		await attachAsync(run);
		run.memory.fileSystem.rmSync(LOCK);
		await passAsync(run, FILE_POLL_MS);
		run.fake.exit("rojo", OK);
		await jumpAsync(run, 50_000);
		run.memory.setModifiedTime("game.rbxl", Date.UTC(2026, 0, 2));
		await passAsync(run, 15_000);

		expect(isEnded()).toBeTrue();
	});

	it("should start the time again on each Studio save, then close Studio", async () => {
		expect.assertions(2);

		const studio: FakeProcess = {
			alive: true,
			executablePath: "/opt/RobloxStudio",
			startTime: "900",
		};
		const run = startCommand({
			...IDLE_UP,
			file: { session: { idleTimeout: 1 }, studio: { autoRecovery: "keep" } },
			files: { ...TOOL_FILES, "game.rbxl": "v1" },
			processes: { [LAUNCHED_PID]: studio },
		});
		studio.onClose = () => {
			run.memory.fileSystem.rmSync(LOCK);
		};

		await flushAsync();
		await attachAsync(run);
		await jumpAsync(run, 50_000);
		run.memory.setModifiedTime("game.rbxl", Date.UTC(2026, 0, 2));
		await passAsync(run, 50_000);
		const before = studio.closeRequests;
		await passAsync(run, 15_000);
		const after = studio.closeRequests;
		run.signals.fire("SIGINT");
		await run.result;

		expect(before).toBeUndefined();
		expect(after).toBe(1);
	});
});

/**
 * Ask the session to restart its parts.
 *
 * @param run - The session.
 * @param parameters - The request's params.
 * @returns The answer, or the failure it rejected with.
 */
async function askRestartAsync(
	run: StartRun,
	parameters: Record<string, unknown> = {},
): Promise<unknown> {
	return callSessionAsync(run.ipc, CONTROL_TARGET, "restartParts", {
		params: parameters,
		responseTimeoutMs: 600_000,
	}).catch((err: unknown) => err);
}

/**
 * Wait until the session asks a service to stop, then let it exit.
 *
 * @param run - The session.
 * @param id - The service.
 * @param report - How its tree ended.
 */
async function exitOnStopAsync(
	run: StartRun,
	id: string,
	report: WorkerReport = OK,
): Promise<void> {
	await vi.waitFor(async () => {
		await passAsync(run, OUTPUT_POLL_MS);
		assert(run.fake.calls.includes(`stop ${id} 3000`), `${id} is asked to stop`);
	});
	run.fake.exit(id, report);
	await passAsync(run, OUTPUT_POLL_MS);
}

/** The Studio a restart starts again. */
const RELAUNCHED_PID = 901;
const RELAUNCHED_LOCK = `${RELAUNCHED_PID}\nRobloxStudioBeta\n${TEST_HOSTNAME}\n`;

describe("forge restart control channel", () => {
	it("should stop the compiler until its tree is gone, then start it again", async () => {
		expect.assertions(3);

		const run = startCommand({ ...WATCH, flags: UP });
		await flushAsync();
		const answer = askRestartAsync(run);
		await exitOnStopAsync(run, "compiler");
		const state = stateOf(run);
		run.signals.fire("SIGINT");
		await run.result;

		await expect(answer).resolves.toStrictEqual({
			added: ["compiler"],
			kept: [],
			stopped: ["compiler"],
		});
		expect(spawnedIds(run.fake)).toStrictEqual(["compiler: ", "compiler: "]);
		expect(state).toMatchObject({
			phase: "ready",
			services: { compiler: { owner: null, status: "ready" } },
		});
	});

	it("should start nothing again when the compiler's tree left processes", async () => {
		expect.assertions(3);

		const run = startCommand({ ...WATCH, flags: UP });
		await flushAsync();
		const answer = askRestartAsync(run);
		await exitOnStopAsync(run, "compiler", { ...OK, incomplete: true });
		const state = stateOf(run);
		run.signals.fire("SIGINT");
		await run.result;

		await expect(answer).resolves.toMatchObject({
			code: "cleanup_in_progress",
			details: { parts: ["compiler"] },
		});
		expect(spawnedIds(run.fake)).toStrictEqual(["compiler: "]);
		expect(state).toMatchObject({ services: { compiler: { status: "off" } } });
	});

	it("should leave the parts a start owns, and restart them with force, each with its owner", async () => {
		expect.assertions(4);

		const run = startCommand({ ...WATCH, flags: UP, owned: true });
		await flushAsync();
		const kept = await askRestartAsync(run);
		const stopsAfterKept = run.fake.calls.filter((call) => call.startsWith("stop "));
		const forced = askRestartAsync(run, { force: true });
		await exitOnStopAsync(run, "compiler");
		const state = stateOf(run);
		run.signals.fire("SIGINT");
		await run.result;

		expect(kept).toStrictEqual({
			added: [],
			kept: [{ owner: "start", part: "compiler" }],
			stopped: [],
		});
		expect(stopsAfterKept).toStrictEqual([]);
		await expect(forced).resolves.toStrictEqual({
			added: ["compiler"],
			kept: [],
			stopped: ["compiler"],
		});
		expect(state).toMatchObject({
			services: { compiler: { owner: "start", status: "ready" } },
		});
	});

	it("should close Studio, then start the compiler, and build, open, and serve only after its first build", async () => {
		expect.assertions(4);

		const run: StartRun = startCommand({
			flags: UP,
			processes: {
				[LAUNCHED_PID]: {
					alive: true,
					executablePath: "/opt/RobloxStudio",
					onClose: () => {
						run.memory.fileSystem.rmSync(LOCK);
					},
					startTime: "900",
				},
			},
			projectType: "rbxts",
		});
		const compilerLog = path.join(SESSION, "output", "compiler.log");
		const built = "Found 0 errors. Watching for file changes.\n";
		await flushAsync();
		run.memory.fileSystem.writeFileSync(compilerLog, built);
		await passAsync(run, OUTPUT_POLL_MS);
		await attachAsync(run);
		const before = spawnedIds(run.fake).length;
		run.studioLauncher.mockResolvedValue({
			studio: { pid: RELAUNCHED_PID, startTime: "901" },
			type: "launched",
		});
		const answer = askRestartAsync(run);
		await exitOnStopAsync(run, "rojo");
		await exitOnStopAsync(run, "compiler");
		await passAsync(run, 2 * FILE_POLL_MS);
		const beforeBuild = spawnedIds(run.fake).slice(before);
		run.memory.fileSystem.writeFileSync(compilerLog, built);
		await passAsync(run, 2 * FILE_POLL_MS);
		run.memory.fileSystem.writeFileSync(LOCK, RELAUNCHED_LOCK);
		await passAsync(run, FILE_POLL_MS);
		const state = stateOf(run);
		run.signals.fire("SIGINT");
		await run.result;

		expect(beforeBuild).toStrictEqual(["compiler: -w"]);
		expect(spawnedIds(run.fake).slice(before)).toStrictEqual([
			"compiler: -w",
			"start-1: build default.project.json --output game.rbxl",
			"rojo: serve default.project.json --port 4000",
		]);
		await expect(answer).resolves.toMatchObject({
			added: ["compiler", "studio", "rojo"],
			kept: [],
			stopped: ["studio", "rojo", "compiler"],
			studio: { place: PLACE, stop: { pid: LAUNCHED_PID, status: "stopped" } },
		});
		expect(state).toMatchObject({
			phase: "ready",
			services: {
				compiler: { status: "ready" },
				rojo: { port: 4000, status: "ready" },
				studio: { pid: RELAUNCHED_PID, status: "open" },
			},
		});
	});
});
