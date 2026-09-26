import { assert, describe, expect, it, onTestFinished } from "vitest";

import type { MemoryTransport } from "../../test/helpers/fake-ipc.ts";
import { createMemoryTransport } from "../../test/helpers/fake-ipc.ts";
import type { FakeNative, FakeProcess, FakeSessionProcess } from "../../test/helpers/native.ts";
import { createFakeNative } from "../../test/helpers/native.ts";
import type { MemoryFileSystem } from "../../test/helpers/seams.ts";
import {
	createMemoryFileSystem,
	createTestSeams,
	PROJECT,
	TEST_HOSTNAME,
} from "../../test/helpers/seams.ts";
import { ForgeError } from "../errors.ts";
import type { IpcHandler } from "../ipc/server.ts";
import { startIpcServer } from "../ipc/server.ts";
import type { FileLock, NativeAddon } from "../native/addon.ts";
import { FORCED_CLEANUP_MS } from "../reaper/reaper-client.ts";
import type { Clock } from "../seams/clock.ts";
import type { SessionStatus } from "../session/status.ts";
import type { RecoveryOptions } from "../studio/close-studio.ts";
import { STUDIO_CLOSE_MS } from "../studio/close-studio.ts";
import type { IdentityRecord } from "../supervisor/session-files.ts";
import { forgeFiles, sessionFiles } from "../supervisor/session-files.ts";
import type { DownOptions, DownPoint, DownReport, DownStudio } from "./down.ts";
import { FORCED_SHUTDOWN_MS, KILL_WAIT_MS, stopSessionAsync, STUDIO_END_WAIT_MS } from "./down.ts";
import type { KnownSession } from "./session.ts";
import { findSession } from "./session.ts";
import { STUDIO_OPEN_WAIT_MS } from "./studio.ts";

const FORGE = forgeFiles(PROJECT);
const FILES = sessionFiles(FORGE, "s1");
const SUPERVISOR = 500;
const TIMEOUT_MS = 1000;
const STUDIO_PID = 4242;
const STUDIO = String.raw`C:\Roblox\Versions\version-1\RobloxStudioBeta.exe`;
const PLACE = `${PROJECT}/game.rbxl`;
const LOCK = `${PLACE}.lock`;
const UNKNOWN: DownStudio = { status: "unknown" };
const RECOVERY: RecoveryOptions = {
	env: {},
	mode: "keep",
	recoveryDirectory: `${PROJECT}/.forge/recovery`,
};
const KEPT = { deleted: [], mode: "keep", moved: [], warnings: [] };
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
 * @param status - Answers `status`; none by default.
 */
async function listenAsync(world: World, shutdown: IpcHandler, status?: IpcHandler): Promise<void> {
	const server = startIpcServer(await world.ipc.listenAsync(IDENTITY.endpoint), {
		handlers: { shutdown, ...(status === undefined ? {} : { status }) },
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
 * @param status - Answers `status`; none by default.
 */
async function serveAsync(
	world: World,
	onShutdown: OnShutdown,
	status?: IpcHandler,
): Promise<void> {
	await listenAsync(
		world,
		(parameters) => {
			world.asked.push(parameters);
			onShutdown(parameters, world);
			return { accepted: true, sessionId: "s1" };
		},
		status,
	);
}

/**
 * The status of a ready session with Rojo alone, and this Studio.
 *
 * @param studio - The Studio entry.
 * @param sessionId - The session that answers.
 * @returns The `status` answer.
 */
function statusWith(
	studio: SessionStatus["services"]["studio"],
	sessionId = "s1",
): () => Record<string, unknown> {
	const status: SessionStatus = {
		phase: "ready",
		pid: SUPERVISOR,
		running: true,
		services: {
			compiler: { building: false, status: "off" },
			rojo: { port: 34_872, status: "ready" },
			studio,
			syncback: { status: "off" },
		},
		sessionId,
		startedAt: IDENTITY.startedAt,
	};
	return () => ({ ...status });
}

const STUDIO_OPEN = statusWith({ place: PLACE, status: "open" });

/**
 * Studio with the place open: its lock file, and its process.
 *
 * @param world - The project.
 * @param studio - How the process behaves.
 * @returns Its entry in the process table.
 */
function openStudio(world: World, studio: Partial<FakeProcess> = {}): FakeProcess {
	world.memory.fileSystem.writeFileSync(
		LOCK,
		`${STUDIO_PID}\nRobloxStudioBeta\n${TEST_HOSTNAME}\n4378769e-07d9-4eda-b5ee-187aa6c43cda\n`,
	);
	const entry: FakeProcess = {
		alive: true,
		executablePath: STUDIO,
		onClose: () => {
			world.memory.fileSystem.rmSync(LOCK, { force: true });
		},
		...studio,
	};
	world.native.processes.set(STUDIO_PID, entry);
	return entry;
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
			host: createTestSeams().host,
			ipc: world.ipc,
			native: () => world.native.addon,
		},
		FORGE,
		world.session,
		{ force: false, keepStudio: false, recovery: RECOVERY, timeoutMs: TIMEOUT_MS, ...options },
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
 * Workers of the session that hold its lease until forced cleanup kills
 * them.
 *
 * @param world - The project.
 * @param entries - Each worker's scan entry.
 */
function holdLease(world: World, ...entries: Array<FakeSessionProcess>): void {
	for (const entry of entries) {
		const lease = world.native.addon.tryLockFile(FILES.lease, "shared");
		assert(lease !== null);
		entry.lease = lease;
	}

	world.native.sessions.set("s1", entries);
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
 * A lock probe that cannot read the lease; with `isDeleted`, the supervisor
 * deletes the session first, as when its final barrier ends meanwhile.
 *
 * @param world - The project.
 * @param isDeleted - Whether the session is gone by then.
 * @returns The addon's lock probe, failing for the lease only.
 */
function failingLeaseRead(world: World, isDeleted: boolean): NativeAddon["isLockFree"] {
	const { isLockFree } = world.native.addon;
	return (file) => {
		if (file !== FILES.lease) {
			return isLockFree(file);
		}

		if (isDeleted) {
			world.exit();
		}

		throw new Error("isLockFree: denied");
	};
}

function failLeaseRead(world: World, isDeleted: boolean): void {
	world.native.addon.isLockFree = failingLeaseRead(world, isDeleted);
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
			studio: UNKNOWN,
		});
		expect(world.asked).toStrictEqual([{ sessionId: "s1" }]);
	});

	it("should close the session's Studio first, then let the session end by itself", async () => {
		expect.assertions(3);

		const world = makeWorld();
		const studio = openStudio(world);
		await serveAsync(world, exitOnShutdown, STUDIO_OPEN);
		at(world, 800, world.exit);

		await expect(downAsync(world)).resolves.toStrictEqual({
			removed: false,
			sessionId: "s1",
			stoppedBy: "studio_closed",
			studio: {
				end: "exited",
				forced: false,
				pid: STUDIO_PID,
				place: PLACE,
				recovery: null,
				status: "closed",
			},
		});
		expect(world.asked).toStrictEqual([]);
		expect(studio).toMatchObject({ alive: false, closeRequests: 1 });
	});

	it("should ask a session that does not end by itself once its Studio closed", async () => {
		expect.assertions(3);

		const world = makeWorld();
		openStudio(world);
		await serveAsync(world, exitOnShutdown, STUDIO_OPEN);

		await expect(downAsync(world)).resolves.toMatchObject({ stoppedBy: "shutdown" });
		expect({ asked: world.asked, waited: world.clock.now() }).toStrictEqual({
			asked: [{ sessionId: "s1" }],
			// The session's syncback wait, plus a margin.
			waited: STUDIO_END_WAIT_MS,
		});
		expect(STUDIO_END_WAIT_MS).toBe(35_000);
	});

	it("should end a Studio that stays open, without a save, and report it", async () => {
		expect.assertions(2);

		const world = makeWorld();
		const studio = openStudio(world, { onCloseRequest: "refuse" });
		await serveAsync(world, exitOnShutdown, STUDIO_OPEN);
		at(world, 100, world.exit);

		await expect(downAsync(world)).resolves.toMatchObject({
			studio: {
				end: "timeout",
				forced: true,
				pid: STUDIO_PID,
				place: PLACE,
				recovery: KEPT,
				status: "closed",
			},
		});
		expect(studio.alive).toBeFalse();
	});

	it("should end a Studio behind a dialog at once", async () => {
		expect.assertions(2);

		const world = makeWorld();
		openStudio(world, { onCloseRequest: "dialog" });
		await serveAsync(world, exitOnShutdown, STUDIO_OPEN);
		at(world, 100, world.exit);

		await expect(downAsync(world)).resolves.toMatchObject({
			studio: { end: "dialog", forced: true, status: "closed" },
		});
		expect(world.memory.fileSystem.existsSync(LOCK)).toBeFalse();
	});

	it("should wait while the session's Studio is opening, then close it", async () => {
		expect.assertions(2);

		const world = makeWorld();
		const studio = openStudio(world);
		let status = statusWith({ status: "opening" });
		at(world, 2000, () => {
			status = STUDIO_OPEN;
		});
		await serveAsync(world, exitOnShutdown, () => status());
		at(world, 2100, world.exit);

		await expect(downAsync(world)).resolves.toMatchObject({
			studio: { end: "exited", status: "closed" },
		});
		expect(studio.closeRequests).toBe(1);
	});

	it("should close the Studio forge started through its pin, once the wait ends", async () => {
		expect.assertions(2);

		const world = makeWorld();
		const studio = openStudio(world);
		world.memory.fileSystem.rmSync(LOCK);
		await serveAsync(
			world,
			exitOnShutdown,
			statusWith({
				pid: STUDIO_PID,
				place: PLACE,
				startTime: String(STUDIO_PID),
				status: "opening",
			}),
		);
		at(world, STUDIO_OPEN_WAIT_MS + 100, world.exit);

		await expect(downAsync(world)).resolves.toMatchObject({
			studio: { end: "exited", pid: STUDIO_PID, status: "closed" },
		});
		expect(studio.alive).toBeFalse();
	});

	it("should touch no Studio when the lock file names another than the one forge started", async () => {
		expect.assertions(2);

		const world = makeWorld();
		const studio = openStudio(world);
		await serveAsync(
			world,
			exitOnShutdown,
			statusWith({ pid: 77, place: PLACE, startTime: "77", status: "open" }),
		);
		world.native.processes.set(77, { alive: true, executablePath: STUDIO });

		await expect(downAsync(world)).resolves.toMatchObject({
			studio: { code: "identity_mismatch", status: "failed" },
		});
		expect(studio.alive).toBeTrue();
	});

	it("should leave Studio open with keepStudio", async () => {
		expect.assertions(2);

		const world = makeWorld();
		const studio = openStudio(world);
		await serveAsync(world, exitOnShutdown, STUDIO_OPEN);

		await expect(downAsync(world, { keepStudio: true })).resolves.toMatchObject({
			stoppedBy: "shutdown",
			studio: { status: "kept" },
		});
		expect(studio).toStrictEqual(expect.objectContaining({ alive: true }));
	});

	it.for([
		["Studio is not open", statusWith({ status: "opening" })],
		["Studio closed the place before", STUDIO_OPEN],
	] as const)("should report no Studio when %s", async ([, status]) => {
		expect.assertions(1);

		const world = makeWorld();
		await serveAsync(world, exitOnShutdown, status);

		await expect(downAsync(world)).resolves.toMatchObject({
			stoppedBy: "shutdown",
			studio: { status: "none" },
		});
	});

	it("should touch no Studio when the status is not one", async () => {
		expect.assertions(2);

		const world = makeWorld();
		const studio = openStudio(world);
		await serveAsync(world, exitOnShutdown, () => ({ phase: "ready" }));

		await expect(downAsync(world)).resolves.toMatchObject({ studio: UNKNOWN });
		expect(studio.alive).toBeTrue();
	});

	it("should touch no Studio when another session answers the status", async () => {
		expect.assertions(2);

		const world = makeWorld();
		const studio = openStudio(world);
		await serveAsync(world, exitOnShutdown, statusWith({ place: PLACE, status: "open" }, "s2"));

		await expect(downAsync(world)).resolves.toMatchObject({ studio: UNKNOWN });
		expect(studio.alive).toBeTrue();
	});

	it("should report a Studio forge cannot verify, touch it not, and still stop the session", async () => {
		expect.assertions(2);

		const world = makeWorld();
		const other = openStudio(world, { executablePath: "/usr/bin/node" });
		await serveAsync(world, exitOnShutdown, STUDIO_OPEN);

		await expect(downAsync(world)).resolves.toMatchObject({
			stoppedBy: "shutdown",
			studio: {
				code: "identity_mismatch",
				message: `${LOCK} names PID ${STUDIO_PID}, but that process is /usr/bin/node, not Roblox Studio. Nothing was killed.`,
				place: PLACE,
				status: "failed",
			},
		});
		expect([other.alive, other.closeRequests]).toStrictEqual([true, undefined]);
	});

	it("should give Studio its close time before it ends it", async () => {
		expect.assertions(1);

		const world = makeWorld();
		openStudio(world, { onCloseRequest: "refuse" });
		await serveAsync(world, exitOnShutdown, STUDIO_OPEN);
		at(world, 100, world.exit);
		await downAsync(world);

		expect(world.clock.now()).toBeGreaterThanOrEqual(STUDIO_CLOSE_MS);
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

	it("should ask for a graceful shutdown once even with no wait", async () => {
		expect.assertions(2);

		const world = makeWorld();
		await serveAsync(world, exitOnShutdown);

		await expect(downAsync(world, { timeoutMs: 0 })).resolves.toMatchObject({
			stoppedBy: "shutdown",
		});
		expect(world.asked).toStrictEqual([{ sessionId: "s1" }]);
	});

	it("should force the shutdown once the wait passed", async () => {
		expect.assertions(3);

		const world = makeWorld();
		await serveAsync(world, exitOnForce);

		await expect(downAsync(world)).resolves.toMatchObject({ stoppedBy: "forced_shutdown" });
		expect(world.asked).toStrictEqual([{ sessionId: "s1" }, { force: true, sessionId: "s1" }]);
		expect(world.clock.now()).toBe(TIMEOUT_MS);
	});

	it("should report supervisor_unresponsive and kill nothing without --force", async () => {
		expect.assertions(3);

		const world = makeWorld();
		await serveAsync(world, ignoreShutdown);

		const error = await downAsync(world).catch((err: unknown) => err);

		expect(error).toBeInstanceOf(ForgeError);
		expect(error).toMatchObject({
			code: "supervisor_unresponsive",
			details: { pid: SUPERVISOR, sessionId: "s1" },
			hint: 'Run "forge down --force" to kill it.',
			message: "The supervisor of session s1 (PID 500) did not stop.",
		});
		expect({
			alive: world.native.processes.get(SUPERVISOR)!.alive,
			files: world.memory.fileSystem.existsSync(FILES.identity),
			waited: world.clock.now(),
		}).toStrictEqual({ alive: true, files: true, waited: TIMEOUT_MS + FORCED_SHUTDOWN_MS });
	});

	it("should kill a supervisor that does not stop through its pin with --force", async () => {
		expect.assertions(2);

		const world = makeWorld();

		await expect(
			downAsync(world, { force: true, pause: async () => unlockAsync(world) }),
		).resolves.toStrictEqual({
			removed: true,
			sessionId: "s1",
			stoppedBy: "killed",
			studio: UNKNOWN,
		});
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
		["a reused PID", { startTime: "999" }, false],
		["a start time mismatch under a held lock", { startTime: "999" }, true],
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

	it("should wait for a supervisor that let go of the lock until it exits", async () => {
		expect.assertions(2);

		const world = makeWorld({ holdsLock: false });
		at(world, 300, () => {
			world.native.processes.get(SUPERVISOR)!.alive = false;
		});

		await expect(downAsync(world)).resolves.toMatchObject({ stoppedBy: "shutdown" });
		expect(world.clock.now()).toBe(300);
	});

	it("should never report stopped while a supervisor that let go of the lock still runs", async () => {
		expect.assertions(2);

		const world = makeWorld({ holdsLock: false });
		at(world, 2500, () => {
			world.native.processes.get(SUPERVISOR)!.alive = false;
		});

		await expect(downAsync(world)).resolves.toMatchObject({ stoppedBy: "forced_shutdown" });
		expect(world.clock.now()).toBe(2500);
	});

	it("should report a live process without the lock unresponsive, and kill nothing with --force", async () => {
		expect.assertions(2);

		const world = makeWorld({ holdsLock: false });

		await expect(downAsync(world, { force: true })).rejects.toMatchObject({
			code: "supervisor_unresponsive",
			hint: "Check the process, and stop it by hand.",
		});
		expect({
			alive: world.native.processes.get(SUPERVISOR)!.alive,
			waited: world.clock.now(),
		}).toStrictEqual({ alive: true, waited: TIMEOUT_MS + FORCED_SHUTDOWN_MS });
	});

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
			studio: UNKNOWN,
		});
		expect({ files: world.memory.files(), locks: world.native.locks.size }).toStrictEqual({
			files: { ".forge/sessions": null },
			locks: 0,
		});
	});

	it("should take a missing session directory as a clear barrier, whatever a scan finds", async () => {
		expect.assertions(1);

		const world = makeWorld({ holdsLock: false, supervisor: { alive: false } });
		world.memory.fileSystem.rmSync(FILES.directory, { force: true, recursive: true });
		world.native.sessions.set("s1", [{ pid: 77 }]);

		await expect(downAsync(world)).resolves.toMatchObject({ removed: false });
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

	it("should report cleanup_in_progress with the PIDs while a worker lives", async () => {
		expect.assertions(2);

		const world = makeWorld({ holdsLock: false, supervisor: { alive: false } });
		holdLease(world, { pid: 77 }, { pid: 78 });

		await expect(downAsync(world)).rejects.toMatchObject({
			code: "cleanup_in_progress",
			details: { pids: [77, 78], sessionId: "s1" },
			hint: 'Wait, then run "forge down" again; or run "forge down --force" to kill them.',
			message: "Processes of session s1 are still alive (PIDs 77, 78).",
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
			studio: UNKNOWN,
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
		holdLease(world, { pid: 77, unverifiable: true }, { pid: 78, unverifiable: true });

		await expect(downAsync(world, { force: true })).rejects.toMatchObject({
			code: "cleanup_unverifiable",
			details: { pids: [77, 78], sessionId: "s1" },
			hint: `Check them, and stop them by hand. The session files are in ${FILES.directory}.`,
			message:
				"Processes of session s1 could not be verified, so they were not killed (PIDs 77, 78).",
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

		await expect(downAsync(world)).rejects.toThrow("isLockFree: denied");
	});

	it("should keep the files while another session holds the lock", async () => {
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
