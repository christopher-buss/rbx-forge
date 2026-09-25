import { describe, expect, it } from "vitest";

import { catchForgeError } from "../../test/helpers/errors.ts";
import { createManualClock } from "../../test/helpers/manual-clock.ts";
import { createFakeNative } from "../../test/helpers/native.ts";
import { createMemoryFileSystem, PROJECT } from "../../test/helpers/seams.ts";
import type { LockSeams } from "./locks.ts";
import {
	acquireSingleton,
	clearOldSessionsAsync,
	LEASE_POLL_MS,
	waitForLeaseAsync,
} from "./locks.ts";
import { forgeFiles, sessionFiles } from "./session-files.ts";

/** A signal that never aborts. */
const NEVER_ABORTS = AbortSignal.any([]);
const FORGE = forgeFiles(PROJECT);
const OLD = sessionFiles(FORGE, "old");

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
 * Let time pass in lease polls, so each poll runs.
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

describe(acquireSingleton, () => {
	it("should take .forge/supervisor.lock exclusively, making .forge first", () => {
		expect.assertions(2);

		const { memory, native, seams } = makeSeams();
		acquireSingleton(seams, FORGE);

		expect(native.locks.get(FORGE.lock)).toStrictEqual(["exclusive"]);
		expect(memory.files()).toStrictEqual({ ".forge": null });
	});

	it("should refuse with session_running while another supervisor holds it", () => {
		expect.assertions(2);

		const { native, seams } = makeSeams();
		native.addon.tryLockFile(FORGE.lock, "exclusive");
		const error = catchForgeError(() => acquireSingleton(seams, FORGE));

		expect(error.code).toBe("session_running");
		expect(error.message).toBe("A session already runs for this project.");
	});
});

describe(waitForLeaseAsync, () => {
	it("should take a free lease at once", async () => {
		expect.assertions(2);

		const { manual, native, seams } = makeSeams();
		const lock = await waitForLeaseAsync(seams, OLD.lease, 1000, NEVER_ABORTS);

		expect(native.locks.get(OLD.lease)).toStrictEqual(["exclusive"]);
		expect([lock === undefined, manual.pending()]).toStrictEqual([false, 0]);
	});

	it("should wait until the last holder lets go", async () => {
		expect.assertions(2);

		const { manual, native, seams } = makeSeams();
		const held = native.addon.tryLockFile(OLD.lease, "shared");
		const waiting = waitForLeaseAsync(seams, OLD.lease, 1000, NEVER_ABORTS);
		await passAsync(manual, 300);

		expect(native.locks.get(OLD.lease)).toStrictEqual(["shared"]);

		held!.release();
		await passAsync(manual, LEASE_POLL_MS);

		await expect(waiting).resolves.toBeDefined();
	});

	it("should give up at the bound", async () => {
		expect.assertions(2);

		const { manual, native, seams } = makeSeams();
		native.addon.tryLockFile(OLD.lease, "shared");
		const waiting = waitForLeaseAsync(seams, OLD.lease, 1000, NEVER_ABORTS);
		await passAsync(manual, 1000);

		await expect(waiting).resolves.toBeUndefined();
		expect(manual.pending()).toBe(0);
	});

	it("should keep trying until the bound, not one poll short", async () => {
		expect.assertions(1);

		const { manual, native, seams } = makeSeams();
		const held = native.addon.tryLockFile(OLD.lease, "shared");
		const waiting = waitForLeaseAsync(seams, OLD.lease, 1000, NEVER_ABORTS);
		await passAsync(manual, 900);
		held!.release();
		await passAsync(manual, LEASE_POLL_MS);

		await expect(waiting).resolves.toBeDefined();
	});

	it("should stop waiting when the signal aborts", async () => {
		expect.assertions(2);

		const { manual, native, seams } = makeSeams();
		native.addon.tryLockFile(OLD.lease, "shared");
		const abort = new AbortController();
		const waiting = waitForLeaseAsync(seams, OLD.lease, 60_000, abort.signal);
		await flushAsync();
		abort.abort();

		await expect(waiting).resolves.toBeUndefined();
		expect(manual.pending()).toBe(0);
	});
});

describe(clearOldSessionsAsync, () => {
	const files = {
		".forge/current": "old\n",
		".forge/sessions/old/supervisor.id": "{}",
		".forge/sessions/older/supervisor.id": "{}",
	};

	it("should delete every old session whose lease is free, and the hint", async () => {
		expect.assertions(2);

		const { memory, native, seams } = makeSeams(files);
		await clearOldSessionsAsync(seams, FORGE, 1000, NEVER_ABORTS);

		expect(memory.files()).toStrictEqual({ ".forge/sessions": null });
		expect(native.locks.size).toBe(0);
	});

	it("should fail with previous_generation_alive when an old lease stays held", async () => {
		expect.assertions(3);

		const { manual, memory, native, seams } = makeSeams(files);
		native.addon.tryLockFile(OLD.lease, "shared");
		const clearing = clearOldSessionsAsync(seams, FORGE, 1000, NEVER_ABORTS);
		const caught = clearing.catch((err: unknown) => err);
		await passAsync(manual, 1000);
		const error = await caught;

		expect(error).toMatchObject({
			code: "previous_generation_alive",
			details: { sessionId: "old" },
			message: `Processes of an earlier session still hold ${OLD.lease}.`,
		});
		expect(Object.keys(memory.files())).toContain(".forge/sessions/old/supervisor.id");
		expect(native.locks.get(OLD.lease)).toStrictEqual(["shared"]);
	});

	it("should keep the old sessions when the signal aborts, holding no lease", async () => {
		expect.assertions(2);

		const { memory, native, seams } = makeSeams(files);
		const abort = new AbortController();
		abort.abort();
		await clearOldSessionsAsync(seams, FORGE, 1000, abort.signal);

		expect(Object.keys(memory.files())).toStrictEqual(Object.keys(files));
		expect(native.locks.size).toBe(0);
	});

	it("should do nothing without a sessions directory", async () => {
		expect.assertions(1);

		const { memory, seams } = makeSeams();
		await clearOldSessionsAsync(seams, FORGE, 1000, NEVER_ABORTS);

		expect(memory.files()).toStrictEqual({});
	});
});
