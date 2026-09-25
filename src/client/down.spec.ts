import { assert, describe, expect, it, onTestFinished } from "vitest";

import type { MemoryTransport } from "../../test/helpers/fake-ipc.ts";
import { createMemoryTransport } from "../../test/helpers/fake-ipc.ts";
import type { FakeNative, FakeProcess, FakeSessionProcess } from "../../test/helpers/native.ts";
import { createFakeNative } from "../../test/helpers/native.ts";
import type { MemoryFileSystem } from "../../test/helpers/seams.ts";
import { createMemoryFileSystem, PROJECT } from "../../test/helpers/seams.ts";
import { ForgeError } from "../errors.ts";
import type { IpcHandler } from "../ipc/server.ts";
import { startIpcServer } from "../ipc/server.ts";
import type { FileLock, NativeAddon } from "../native/addon.ts";
import { FORCED_CLEANUP_MS } from "../reaper/reaper-client.ts";
import type { Clock } from "../seams/clock.ts";
import type { IdentityRecord } from "../supervisor/session-files.ts";
import { forgeFiles, sessionFiles } from "../supervisor/session-files.ts";
import type { DownOptions, DownPoint, DownReport } from "./down.ts";
import { DOWN_POLL_MS, FORCED_SHUTDOWN_MS, KILL_WAIT_MS, stopSessionAsync } from "./down.ts";
import type { KnownSession } from "./session.ts";
import { findSession } from "./session.ts";

const FORGE = forgeFiles(PROJECT);
const FILES = sessionFiles(FORGE, "s1");
const SUPERVISOR = 500;
const TIMEOUT_MS = 1000;
const IDENTITY: IdentityRecord = {
	endpoint: "endpoint-s1",
	pid: SUPERVISOR,
	processStartTime: String(SUPERVISOR),
	sessionId: "s1",
	startedAt: "2026-01-01T00:00:00.000Z",
	version: "9.9.9",
};

/** The project, its supervisor, and what `down` saw. */
interface World {
	/** Every shutdown request's params, in order. */
	asked: Array<Record<string, unknown>>;
	/** A clock whose sleeps move time and run {@link World.onSleep}. */
	clock: Clock;
	/** The supervisor exits: process gone, lock free, files deleted. */
	exit: () => void;
	ipc: MemoryTransport;
	memory: MemoryFileSystem;
	native: FakeNative;
	/** Runs on each of `down`'s sleeps, once the time moved. */
	onSleep: Array<(now: number) => void>;
	session: KnownSession;
	/** The OS frees the supervisor's singleton lock. */
	unlock: () => void;
}

/** What the fake supervisor does with a shutdown request. */
type OnShutdown = (parameters: Record<string, unknown>, world: World) => void;

interface WorldSetup {
	/** The supervisor holds the singleton lock (the default). */
	holdsLock?: boolean;
	/** The supervisor process; by default alive, with the recorded start. */
	supervisor?: Partial<FakeProcess>;
}

function writeSession({ fileSystem }: MemoryFileSystem): void {
	fileSystem.mkdirSync(FILES.output, { recursive: true });
	fileSystem.writeFileSync(FILES.identity, `${JSON.stringify(IDENTITY)}\n`);
	fileSystem.writeFileSync(FILES.token, "token");
	fileSystem.writeFileSync(FORGE.current, "s1\n");
}

function makeClock(onSleep: World["onSleep"]): Clock {
	let now = 0;
	return {
		now: () => now,
		sleep: async (ms) => {
			now += ms;
			for (const hook of onSleep) {
				hook(now);
			}

			await Promise.resolve();
		},
	};
}

function makeWorld({ holdsLock = true, supervisor = {} }: WorldSetup = {}): World {
	const memory = createMemoryFileSystem();
	writeSession(memory);
	const native = createFakeNative({
		[SUPERVISOR]: { alive: true, executablePath: "/node", ...supervisor },
	});
	const lock = holdsLock ? native.addon.tryLockFile(FORGE.lock, "exclusive") : null;
	const session = findSession(memory.fileSystem, FORGE);
	assert(session !== undefined);
	const onSleep: World["onSleep"] = [];
	return {
		asked: [],
		clock: makeClock(onSleep),
		exit: () => {
			native.processes.get(SUPERVISOR)!.alive = false;
			lock?.release();
			memory.fileSystem.rmSync(FILES.directory, { force: true, recursive: true });
			memory.fileSystem.rmSync(FORGE.current, { force: true });
		},
		ipc: createMemoryTransport(),
		memory,
		native,
		onSleep,
		session,
		unlock: () => {
			lock?.release();
		},
	};
}

/**
 * Open the session's control endpoint.
 *
 * @param world - The project.
 * @param shutdown - Answers `shutdown`.
 */
async function listenAsync(world: World, shutdown: IpcHandler): Promise<void> {
	const server = startIpcServer(await world.ipc.listenAsync(IDENTITY.endpoint), {
		handlers: { shutdown },
		token: "token",
	});
	onTestFinished(async () => {
		await server.closeAsync();
	});
}

/**
 * Serve the session's control endpoint: `shutdown` is recorded, accepted,
 * and passed to `onShutdown`.
 *
 * @param world - The project.
 * @param onShutdown - What the supervisor does on it.
 */
async function serveAsync(world: World, onShutdown: OnShutdown): Promise<void> {
	await listenAsync(world, (parameters) => {
		world.asked.push(parameters);
		onShutdown(parameters, world);
		return { accepted: true, sessionId: "s1" };
	});
}

/**
 * Run `action` once, on the first sleep that reaches `ms`.
 *
 * @param world - The project.
 * @param ms - When.
 * @param action - What happens then.
 */
function at(world: World, ms: number, action: () => void): void {
	let isDone = false;
	world.onSleep.push((now) => {
		if (isDone || now < ms) {
			return;
		}

		isDone = true;
		action();
	});
}

async function downAsync(world: World, options: Partial<DownOptions> = {}): Promise<DownReport> {
	return stopSessionAsync(
		{
			clock: world.clock,
			fileSystem: world.memory.fileSystem,
			ipc: world.ipc,
			native: () => world.native.addon,
		},
		FORGE,
		world.session,
		{ force: false, timeoutMs: TIMEOUT_MS, ...options },
	);
}

function exitOnShutdown(_parameters: Record<string, unknown>, world: World): void {
	world.exit();
}

function exitOnForce(parameters: Record<string, unknown>, world: World): void {
	if (parameters["force"] === true) {
		world.exit();
	}
}

function ignoreShutdown(): void {
	// A stalled supervisor accepts and does nothing.
}

/**
 * A worker of the session that holds its lease until forced cleanup kills
 * it.
 *
 * @param world - The project.
 * @param entry - The worker's scan entry.
 */
function holdLease(world: World, entry: FakeSessionProcess): void {
	const lease = world.native.addon.tryLockFile(FILES.lease, "shared");
	assert(lease !== null);
	world.native.sessions.set("s1", [{ ...entry, lease }]);
}

/**
 * A pause that notes each point, and lets another session take the
 * singleton lock before the delete.
 *
 * @param world - The project.
 * @param points - Gets each point.
 * @returns The pause.
 */
function otherSessionAtDelete(
	world: World,
	points: Array<DownPoint>,
): (point: DownPoint) => Promise<void> {
	let other: FileLock | null = null;
	onTestFinished(() => {
		other?.release();
	});
	return async (point) => {
		points.push(point);
		if (point === "delete") {
			other = world.native.addon.tryLockFile(FORGE.lock, "exclusive");
		}
	};
}

/**
 * A lock call that cannot read the lease; with `isDeleted`, the supervisor
 * deletes the session first, as when its final barrier ends meanwhile.
 *
 * @param world - The project.
 * @param isDeleted - Whether the session is gone by then.
 * @returns The addon's lock call, failing for the lease only.
 */
function failingLeaseRead(world: World, isDeleted: boolean): NativeAddon["tryLockFile"] {
	const { tryLockFile } = world.native.addon;
	return (file, mode) => {
		if (file !== FILES.lease) {
			return tryLockFile(file, mode);
		}

		if (isDeleted) {
			world.exit();
		}

		throw new Error("tryLockFile: denied");
	};
}

function failLeaseRead(world: World, isDeleted: boolean): void {
	world.native.addon.tryLockFile = failingLeaseRead(world, isDeleted);
}

async function unlockAsync(world: World): Promise<void> {
	world.unlock();
}

describe(stopSessionAsync, () => {
	it("should stop the session on shutdown and report its supervisor's exit", async () => {
		expect.assertions(2);

		const world = makeWorld();
		await serveAsync(world, exitOnShutdown);

		await expect(downAsync(world)).resolves.toStrictEqual({
			removed: false,
			sessionId: "s1",
			stoppedBy: "shutdown",
		});
		expect(world.asked).toStrictEqual([{ sessionId: "s1" }]);
	});

	it("should wait for the supervisor after it accepted, asking once", async () => {
		expect.assertions(2);

		const world = makeWorld();
		await serveAsync(world, ignoreShutdown);
		at(world, 500, world.exit);

		await expect(downAsync(world)).resolves.toMatchObject({ stoppedBy: "shutdown" });
		expect(world.asked).toHaveLength(1);
	});

	it("should ask again while the endpoint is not open yet", async () => {
		expect.assertions(2);

		const world = makeWorld();
		at(world, 300, () => {
			void serveAsync(world, exitOnShutdown);
		});

		await expect(downAsync(world)).resolves.toMatchObject({ stoppedBy: "shutdown" });
		expect(world.asked).toStrictEqual([{ sessionId: "s1" }]);
	});

	it("should force the shutdown once the wait passed", async () => {
		expect.assertions(3);

		const world = makeWorld();
		await serveAsync(world, exitOnForce);

		await expect(downAsync(world)).resolves.toMatchObject({ stoppedBy: "forced_shutdown" });
		expect(world.asked).toStrictEqual([{ sessionId: "s1" }, { force: true, sessionId: "s1" }]);
		expect(world.clock.now()).toBe(TIMEOUT_MS + DOWN_POLL_MS);
	});

	it("should report supervisor_unresponsive and kill nothing without --force (C14)", async () => {
		expect.assertions(3);

		const world = makeWorld();
		await serveAsync(world, ignoreShutdown);

		const error = await downAsync(world).catch((err: unknown) => err);

		expect(error).toBeInstanceOf(ForgeError);
		expect(error).toMatchObject({
			code: "supervisor_unresponsive",
			details: { pid: SUPERVISOR, sessionId: "s1" },
			hint: 'Run "forge down --force" to kill it.',
		});
		expect({
			alive: world.native.processes.get(SUPERVISOR)!.alive,
			files: world.memory.fileSystem.existsSync(FILES.identity),
			waited: world.clock.now(),
		}).toStrictEqual({ alive: true, files: true, waited: TIMEOUT_MS + FORCED_SHUTDOWN_MS });
	});

	it("should kill a supervisor that does not stop through its pin with --force (F1, F5)", async () => {
		expect.assertions(2);

		const world = makeWorld();

		await expect(
			downAsync(world, { force: true, pause: async () => unlockAsync(world) }),
		).resolves.toStrictEqual({ removed: true, sessionId: "s1", stoppedBy: "killed" });
		expect(world.native.processes.get(SUPERVISOR)!.alive).toBeFalse();
	});

	it("should report supervisor_unresponsive when the killed supervisor stays", async () => {
		expect.assertions(2);

		const world = makeWorld({ supervisor: { ignoresKill: true } });

		const error = await downAsync(world, { force: true }).catch((err: unknown) => err);

		expect(error).toMatchObject({
			code: "supervisor_unresponsive",
			hint: "Check the process, and stop it by hand.",
		});
		expect(world.clock.now()).toBe(TIMEOUT_MS + FORCED_SHUTDOWN_MS + KILL_WAIT_MS);
	});

	it.for([
		["a reused PID (F2)", { startTime: "999" }, false],
		["a start time mismatch under a held lock (F3)", { startTime: "999" }, true],
		["a free lock with a stale record (F6)", {}, false],
	] as const)(
		"should kill nothing for %s, and report it gone",
		async ([, supervisor, holdsLock]) => {
			expect.assertions(2);

			const world = makeWorld({ holdsLock, supervisor });

			await expect(downAsync(world, { force: true })).resolves.toMatchObject({
				stoppedBy: "gone",
			});
			expect(world.native.processes.get(SUPERVISOR)!.alive).toBeTrue();
		},
	);

	it("should treat a supervisor it cannot open as gone", async () => {
		expect.assertions(1);

		const world = makeWorld({ supervisor: { pinError: "access denied" } });

		await expect(downAsync(world, { force: true })).resolves.toMatchObject({
			stoppedBy: "gone",
		});
	});

	it("should delete the files of a session whose supervisor is gone, under the lock", async () => {
		expect.assertions(2);

		const world = makeWorld({ holdsLock: false, supervisor: { alive: false } });

		await expect(downAsync(world)).resolves.toStrictEqual({
			removed: true,
			sessionId: "s1",
			stoppedBy: "gone",
		});
		expect(world.native.locks.size).toBe(0);
	});

	it("should report session_replaced when another session answers, and stop nothing", async () => {
		expect.assertions(1);

		const world = makeWorld();
		await listenAsync(world, () => {
			throw new ForgeError("session_replaced", "Session s1 is gone.", {
				details: { sessionId: "s2" },
			});
		});

		await expect(downAsync(world)).rejects.toMatchObject({
			code: "session_replaced",
			details: { sessionId: "s2" },
		});
	});

	it("should report cleanup_in_progress with the PIDs while a worker lives (C10)", async () => {
		expect.assertions(2);

		const world = makeWorld({ holdsLock: false, supervisor: { alive: false } });
		holdLease(world, { pid: 77 });

		await expect(downAsync(world)).rejects.toMatchObject({
			code: "cleanup_in_progress",
			details: { pids: [77], sessionId: "s1" },
		});
		expect(world.memory.fileSystem.existsSync(FILES.identity)).toBeTrue();
	});

	it("should wait for a held lease even when the scan finds no process", async () => {
		expect.assertions(1);

		const world = makeWorld({ holdsLock: false, supervisor: { alive: false } });
		world.native.addon.tryLockFile(FILES.lease, "shared");

		await expect(downAsync(world)).rejects.toMatchObject({
			code: "cleanup_in_progress",
			details: { pids: [] },
			message: "Processes of session s1 are still alive.",
		});
	});

	it("should clean up what outlived the barrier with --force", async () => {
		expect.assertions(2);

		const world = makeWorld({ holdsLock: false, supervisor: { alive: false } });
		holdLease(world, { pid: 77 });

		await expect(downAsync(world, { force: true })).resolves.toStrictEqual({
			cleanup: { killed: [77], survivors: [], unverifiable: [] },
			removed: true,
			sessionId: "s1",
			stoppedBy: "gone",
		});
		expect(world.native.cleanups).toStrictEqual([
			{
				boundMs: FORCED_CLEANUP_MS,
				target: { leasePath: FILES.lease, recordPath: FILES.record, sessionId: "s1" },
			},
		]);
	});

	it("should report cleanup_unverifiable and kill nothing it cannot verify", async () => {
		expect.assertions(1);

		const world = makeWorld({ holdsLock: false, supervisor: { alive: false } });
		holdLease(world, { pid: 77, unverifiable: true });

		await expect(downAsync(world, { force: true })).rejects.toMatchObject({
			code: "cleanup_unverifiable",
			details: { pids: [77], sessionId: "s1" },
		});
	});

	it("should report cleanup_in_progress when a process survives the forced cleanup", async () => {
		expect.assertions(1);

		const world = makeWorld({ holdsLock: false, supervisor: { alive: false } });
		holdLease(world, { pid: 77, survivesCleanup: true });

		await expect(downAsync(world, { force: true })).rejects.toMatchObject({
			code: "cleanup_in_progress",
			details: { pids: [77] },
			message: "Processes of session s1 are still alive (PIDs 77).",
		});
	});

	it("should treat a session its supervisor deleted during the barrier as clear", async () => {
		expect.assertions(1);

		const world = makeWorld({ holdsLock: false, supervisor: { alive: false } });
		failLeaseRead(world, true);

		await expect(downAsync(world)).resolves.toMatchObject({ removed: false });
	});

	it("should fail when the lease cannot be read while the session is there", async () => {
		expect.assertions(1);

		const world = makeWorld({ holdsLock: false, supervisor: { alive: false } });
		failLeaseRead(world, false);

		await expect(downAsync(world)).rejects.toThrow("tryLockFile: denied");
	});

	it("should keep the files while another session holds the lock (C12)", async () => {
		expect.assertions(3);

		const world = makeWorld({ holdsLock: false, supervisor: { alive: false } });
		const points: Array<DownPoint> = [];

		await expect(
			downAsync(world, { pause: otherSessionAtDelete(world, points) }),
		).resolves.toMatchObject({ removed: false });
		expect(points).toStrictEqual(["barrier", "delete"]);
		expect(world.memory.fileSystem.existsSync(FILES.identity)).toBeTrue();
	});
});
