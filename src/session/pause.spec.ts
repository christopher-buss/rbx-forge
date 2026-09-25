import path from "node:path";
import { describe, expect, it } from "vitest";

import { createManualClock } from "../../test/helpers/manual-clock.ts";
import { createMemoryFileSystem, PROJECT } from "../../test/helpers/seams.ts";
import type { Pause } from "./pause.ts";
import { createFilePause, neverPauseAsync, parsePausePoints, PAUSE_POLL_MS } from "./pause.ts";

/** A signal that never aborts. */
const NEVER_ABORTS = AbortSignal.any([]);
const DIRECTORY = path.join(PROJECT, "pauses");
const PAUSED = path.join(DIRECTORY, "lock.paused");

function makePause(points: ReadonlyArray<string>) {
	const memory = createMemoryFileSystem();
	const manual = createManualClock();
	const pause: Pause = createFilePause({
		clock: manual.clock,
		directory: DIRECTORY,
		fileSystem: memory.fileSystem,
		pid: 77,
		points: new Set(points),
	});
	return { manual, memory, pause };
}

async function flushAsync(): Promise<void> {
	await new Promise((resolve) => {
		setImmediate(resolve);
	});
}

describe(createFilePause, () => {
	it("should pass a point it does not list", async () => {
		expect.assertions(2);

		const { memory, pause } = makePause(["leased"]);

		await expect(pause("lock", NEVER_ABORTS)).resolves.toBeUndefined();
		expect(memory.files()).toStrictEqual({});
	});

	it("should write its PID to the pause file and wait until the file is gone", async () => {
		expect.assertions(3);

		const { manual, memory, pause } = makePause(["lock"]);
		let isDone = false;
		const paused = (async () => {
			await pause("lock", NEVER_ABORTS);
			isDone = true;
		})();
		await flushAsync();
		manual.advance(PAUSE_POLL_MS);
		await flushAsync();

		expect([memory.files()["pauses/lock.paused"], isDone]).toStrictEqual(["77", false]);

		memory.fileSystem.rmSync(PAUSED);
		manual.advance(PAUSE_POLL_MS);
		await paused;

		expect(isDone).toBeTrue();
		expect(manual.pending()).toBe(0);
	});

	it("should stop waiting once the signal aborts", async () => {
		expect.assertions(2);

		const { manual, memory, pause } = makePause(["lock"]);
		const abort = new AbortController();
		const paused = pause("lock", abort.signal);
		await flushAsync();
		abort.abort();

		await expect(paused).resolves.toBeUndefined();
		expect([manual.pending(), memory.files()["pauses/lock.paused"]]).toStrictEqual([0, "77"]);
	});
});

describe(parsePausePoints, () => {
	it("should read a comma list and nothing from an unset or empty variable", () => {
		expect.assertions(3);

		expect([...parsePausePoints("lock,,leased")]).toStrictEqual(["lock", "leased"]);
		expect(parsePausePoints(undefined).size).toBe(0);
		expect(parsePausePoints("").size).toBe(0);
	});
});

describe(neverPauseAsync, () => {
	it("should never wait", async () => {
		expect.assertions(1);

		await expect(neverPauseAsync()).resolves.toBeUndefined();
	});
});
