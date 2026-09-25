import { assert, describe, expect, it } from "vitest";

import { createManualClock } from "../../test/helpers/manual-clock.ts";
import type { FakeSessionProcess } from "../../test/helpers/native.ts";
import { createFakeNative } from "../../test/helpers/native.ts";
import { createMemoryFileSystem, PROJECT } from "../../test/helpers/seams.ts";
import { FORCED_CLEANUP_MS } from "../reaper/reaper-client.ts";
import { clearOldSessionsAsync, SETTLE_MS, targetOf, waitForBarrierAsync } from "./barrier.ts";
import type { LockSeams } from "./locks.ts";
import { LEASE_POLL_MS } from "./locks.ts";
import { forgeFiles, sessionFiles } from "./session-files.ts";

/** A signal that never aborts. */
const NEVER_ABORTS = AbortSignal.any([]);
const FORGE = forgeFiles(PROJECT);
const OLD = sessionFiles(FORGE, "old");
const OLD_FILES = {
	".forge/current": "old\n",
	".forge/sessions/old/supervisor.id": "{}",
	".forge/sessions/older/supervisor.id": "{}",
};

function makeSeams(files: Record<string, string> = {}) {
	const memory = createMemoryFileSystem(files);
	const manual = createManualClock();
	const native = createFakeNative();
	const seams: LockSeams = {
		clock: manual.clock,
		fileSystem: memory.fileSystem,
		native: () => native.addon,
	};
	return { manual, memory, native, seams };
}

async function flushAsync(): Promise<void> {
	await new Promise((resolve) => {
		setImmediate(resolve);
	});
}

/**
 * Let time pass in polls, so each poll runs.
 *
 * @param manual - The clock.
 * @param ms - How long.
 */
async function passAsync(manual: ReturnType<typeof createManualClock>, ms: number): Promise<void> {
	for (let passed = 0; passed < ms; passed += LEASE_POLL_MS) {
		await flushAsync();
		manual.advance(LEASE_POLL_MS);
	}

	await flushAsync();
}

/**
 * An old session's worker that holds the lease (POSIX) until it dies.
 *
 * @param native - The fake addon.
 * @param process - The worker's scan entry.
 * @returns The worker.
 */
function leaseHolder(
	native: ReturnType<typeof createFakeNative>,
	process: FakeSessionProcess = {},
): FakeSessionProcess {
	const lease = native.addon.tryLockFile(OLD.lease, "shared");
	assert(lease !== null);
	return { ...process, lease };
}

describe(targetOf, () => {
	it("should name the session's id, lease, and reaper record", () => {
		expect.assertions(1);

		expect(targetOf(OLD)).toStrictEqual({
			leasePath: OLD.lease,
			recordPath: OLD.record,
			sessionId: "old",
		});
	});
});

describe(waitForBarrierAsync, () => {
	it("should clear at once when the lease is free and no process is left, holding nothing", async () => {
		expect.assertions(2);

		const { manual, native, seams } = makeSeams();
		const barrier = await waitForBarrierAsync(seams, OLD, 1000, NEVER_ABORTS);

		expect(barrier).toStrictEqual({ clear: true, pids: [] });
		expect([native.locks.size, manual.pending()]).toStrictEqual([0, 0]);
	});

	it("should wait while a process that closed the lease still carries the marker (C8)", async () => {
		expect.assertions(2);

		const { manual, native, seams } = makeSeams();
		native.sessions.set("old", [{ pid: 41 }]);
		const waiting = waitForBarrierAsync(seams, OLD, 1000, NEVER_ABORTS);
		await passAsync(manual, 300);
		native.sessions.set("old", []);
		await passAsync(manual, LEASE_POLL_MS);

		await expect(waiting).resolves.toStrictEqual({ clear: true, pids: [] });
		expect(native.locks.size).toBe(0);
	});

	it("should wait until the last lease holder lets go", async () => {
		expect.assertions(1);

		const { manual, native, seams } = makeSeams();
		const holder = leaseHolder(native);
		const waiting = waitForBarrierAsync(seams, OLD, 1000, NEVER_ABORTS);
		await passAsync(manual, 900);
		holder.lease!.release();
		await passAsync(manual, LEASE_POLL_MS);

		await expect(waiting).resolves.toStrictEqual({ clear: true, pids: [] });
	});

	it("should report the surviving PIDs at the bound", async () => {
		expect.assertions(2);

		const { manual, native, seams } = makeSeams();
		native.sessions.set("old", [leaseHolder(native, { pid: 41 }), { pid: 42 }]);
		const waiting = waitForBarrierAsync(seams, OLD, 1000, NEVER_ABORTS);
		await passAsync(manual, 1000);

		await expect(waiting).resolves.toStrictEqual({ clear: false, pids: [41, 42] });
		expect(manual.pending()).toBe(0);
	});

	it("should report a held lease with no process it can name as not clear", async () => {
		expect.assertions(1);

		const { manual, native, seams } = makeSeams();
		leaseHolder(native);
		const waiting = waitForBarrierAsync(seams, OLD, 0, NEVER_ABORTS);
		await passAsync(manual, 0);

		await expect(waiting).resolves.toStrictEqual({ clear: false, pids: [] });
	});

	it("should stop waiting when the signal aborts", async () => {
		expect.assertions(2);

		const { manual, native, seams } = makeSeams();
		leaseHolder(native);
		const abort = new AbortController();
		const waiting = waitForBarrierAsync(seams, OLD, 60_000, abort.signal);
		await flushAsync();
		abort.abort();

		await expect(waiting).resolves.toBeUndefined();
		expect(manual.pending()).toBe(0);
	});
});

describe(clearOldSessionsAsync, () => {
	it("should delete every old session whose barrier is clear, and the hint", async () => {
		expect.assertions(3);

		const { memory, native, seams } = makeSeams(OLD_FILES);
		const cleanups = await clearOldSessionsAsync(seams, FORGE, {
			boundMs: 1000,
			force: false,
			signal: NEVER_ABORTS,
		});

		expect(memory.files()).toStrictEqual({ ".forge/sessions": null });
		expect(native.locks.size).toBe(0);
		expect([cleanups, native.cleanups]).toStrictEqual([[], []]);
	});

	it("should fail with previous_generation_alive and the PIDs when an old session outlives the bound (C4)", async () => {
		expect.assertions(3);

		const { manual, memory, native, seams } = makeSeams(OLD_FILES);
		native.sessions.set("old", [leaseHolder(native, { pid: 41 }), { pid: 42 }]);
		const caught = clearOldSessionsAsync(seams, FORGE, {
			boundMs: 1000,
			force: false,
			signal: NEVER_ABORTS,
		}).catch((err: unknown) => err);
		await passAsync(manual, 1000);

		await expect(caught).resolves.toMatchObject({
			code: "previous_generation_alive",
			details: { pids: [41, 42], sessionId: "old" },
			hint: `Wait for them to exit, or run again with --force to kill them. Their session files are in ${OLD.directory}.`,
			message: "Processes of an earlier session are still alive (PIDs 41, 42).",
		});
		expect(Object.keys(memory.files())).toContain(".forge/sessions/old/supervisor.id");
		expect(native.cleanups).toStrictEqual([]);
	});

	it("should name no PIDs when it cannot name the lease's holder", async () => {
		expect.assertions(1);

		const { manual, native, seams } = makeSeams(OLD_FILES);
		leaseHolder(native);
		const caught = clearOldSessionsAsync(seams, FORGE, {
			boundMs: 0,
			force: false,
			signal: NEVER_ABORTS,
		}).catch((err: unknown) => err);
		await passAsync(manual, 0);

		await expect(caught).resolves.toMatchObject({
			details: { pids: [] },
			message: "Processes of an earlier session are still alive.",
		});
	});

	it("should force-clean an old session that outlives the bound, then delete it (C4, C7)", async () => {
		expect.assertions(3);

		const { manual, memory, native, seams } = makeSeams(OLD_FILES);
		native.sessions.set("old", [
			leaseHolder(native, { isReaper: true, pid: 40 }),
			leaseHolder(native, { pid: 41 }),
			{ pid: 42 },
		]);
		const clearing = clearOldSessionsAsync(seams, FORGE, {
			boundMs: 1000,
			force: true,
			signal: NEVER_ABORTS,
		});
		await passAsync(manual, 1000);

		await expect(clearing).resolves.toStrictEqual([
			{ killed: [41, 42, 40], sessionId: "old", survivors: [], unverifiable: [] },
		]);
		expect(native.cleanups).toStrictEqual([
			{ boundMs: FORCED_CLEANUP_MS, target: targetOf(OLD) },
		]);
		expect(memory.files()).toStrictEqual({ ".forge/sessions": null });
	});

	it("should not force-clean an old session whose barrier clears within the bound", async () => {
		expect.assertions(1);

		const { manual, native, seams } = makeSeams(OLD_FILES);
		const holder = leaseHolder(native);
		const clearing = clearOldSessionsAsync(seams, FORGE, {
			boundMs: 1000,
			force: true,
			signal: NEVER_ABORTS,
		});
		await passAsync(manual, 500);
		holder.lease!.release();
		await passAsync(manual, LEASE_POLL_MS);
		await clearing;

		expect(native.cleanups).toStrictEqual([]);
	});

	it("should refuse with cleanup_unverifiable, killing none of them, and keep the files", async () => {
		expect.assertions(2);

		const { manual, memory, native, seams } = makeSeams(OLD_FILES);
		native.sessions.set("old", [
			{ pid: 42, unverifiable: true },
			{ pid: 43, unverifiable: true },
		]);
		const caught = clearOldSessionsAsync(seams, FORGE, {
			boundMs: 0,
			force: true,
			signal: NEVER_ABORTS,
		}).catch((err: unknown) => err);
		await passAsync(manual, 0);

		await expect(caught).resolves.toMatchObject({
			code: "cleanup_unverifiable",
			details: {
				cleanup: { killed: [], sessionId: "old", survivors: [], unverifiable: [42, 43] },
				pids: [42, 43],
				sessionId: "old",
			},
			hint: `Check them, and stop them by hand. Their session files are in ${OLD.directory}.`,
			message:
				"Processes of an earlier session could not be verified, so they were not killed (PIDs 42, 43).",
		});
		expect(Object.keys(memory.files())).toContain(".forge/sessions/old/supervisor.id");
	});

	it("should fail with previous_generation_alive when processes survive the cleanup", async () => {
		expect.assertions(1);

		const { manual, native, seams } = makeSeams(OLD_FILES);
		native.sessions.set("old", [{ pid: 42, survivesCleanup: true }]);
		const caught = clearOldSessionsAsync(seams, FORGE, {
			boundMs: 0,
			force: true,
			signal: NEVER_ABORTS,
		}).catch((err: unknown) => err);
		await passAsync(manual, SETTLE_MS);

		await expect(caught).resolves.toMatchObject({
			code: "previous_generation_alive",
			details: { pids: [42], sessionId: "old" },
		});
	});

	it("should wait for the settle time after a cleanup, not less", async () => {
		expect.assertions(1);

		const { manual, native, seams } = makeSeams(OLD_FILES);
		const dying: FakeSessionProcess = { pid: 42, survivesCleanup: true };
		native.sessions.set("old", [dying]);
		const clearing = clearOldSessionsAsync(seams, FORGE, {
			boundMs: 0,
			force: true,
			signal: NEVER_ABORTS,
		});
		await passAsync(manual, SETTLE_MS - LEASE_POLL_MS);
		native.sessions.set("old", []);
		await passAsync(manual, LEASE_POLL_MS);

		await expect(clearing).resolves.toHaveLength(1);
	});

	it("should keep the old sessions when the signal aborts, holding no lease", async () => {
		expect.assertions(2);

		const { native, seams } = makeSeams(OLD_FILES);
		const holder = leaseHolder(native);
		const abort = new AbortController();
		abort.abort();
		await clearOldSessionsAsync(seams, FORGE, {
			boundMs: 1000,
			force: true,
			signal: abort.signal,
		});
		holder.lease!.release();

		expect(native.locks.size).toBe(0);
		expect(native.cleanups).toStrictEqual([]);
	});

	it("should keep the files when the signal aborts while it waits after a cleanup", async () => {
		expect.assertions(2);

		const { manual, memory, native, seams } = makeSeams(OLD_FILES);
		native.sessions.set("old", [{ pid: 42, survivesCleanup: true }]);
		const abort = new AbortController();
		const clearing = clearOldSessionsAsync(seams, FORGE, {
			boundMs: 0,
			force: true,
			signal: abort.signal,
		});
		await passAsync(manual, LEASE_POLL_MS);
		abort.abort();

		await expect(clearing).resolves.toStrictEqual([]);
		expect(Object.keys(memory.files())).toContain(".forge/sessions/old/supervisor.id");
	});

	it("should do nothing without a sessions directory", async () => {
		expect.assertions(1);

		const { memory, seams } = makeSeams();
		await clearOldSessionsAsync(seams, FORGE, {
			boundMs: 1000,
			force: false,
			signal: NEVER_ABORTS,
		});

		expect(memory.files()).toStrictEqual({});
	});
});
