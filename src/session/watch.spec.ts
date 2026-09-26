import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createManualClock } from "../../test/helpers/manual-clock.ts";
import type { ManualClock } from "../../test/helpers/manual-clock.ts";
import { createMemoryFileSystem, PROJECT } from "../../test/helpers/seams.ts";
import type { MemoryFileSystem } from "../../test/helpers/seams.ts";
import type { WatchOptions } from "./watch.ts";
import { waitForStudioCloseAsync, watchSaves } from "./watch.ts";

const PLACE = path.join(PROJECT, "game.rbxl");
const LOCK = `${PLACE}.lock`;
const ANY_STUDIO = { path: LOCK, pid: undefined };
const STUDIO_7 = { path: LOCK, pid: 7 };

interface Watching {
	abort: AbortController;
	clock: ManualClock;
	memory: MemoryFileSystem;
	options: WatchOptions;
	/** Let time pass by one interval, and let the watch look. */
	tickAsync: () => Promise<void>;
}

async function flushAsync(): Promise<void> {
	await new Promise((resolve) => {
		setImmediate(resolve);
	});
}

function watching(files: Record<string, string> = {}): Watching {
	const memory = createMemoryFileSystem(files);
	const clock = createManualClock();
	const abort = new AbortController();
	return {
		abort,
		clock,
		memory,
		options: {
			clock: clock.clock,
			fileSystem: memory.fileSystem,
			intervalMs: 100,
			signal: abort.signal,
		},
		tickAsync: async () => {
			clock.advance(100);
			await flushAsync();
		},
	};
}

describe(waitForStudioCloseAsync, () => {
	it("should resolve true once the lock file appeared and went away", async () => {
		expect.assertions(3);

		const watch = watching();
		const onOpen = vi.fn<() => void>();
		const closed = waitForStudioCloseAsync(watch.options, ANY_STUDIO, onOpen);
		await watch.tickAsync();

		expect(onOpen).not.toHaveBeenCalled();

		watch.memory.fileSystem.writeFileSync(LOCK, "1");
		await watch.tickAsync();
		await watch.tickAsync();

		expect(onOpen).toHaveBeenCalledOnce();

		watch.memory.fileSystem.rmSync(LOCK);
		await watch.tickAsync();

		await expect(closed).resolves.toBeTrue();
	});

	it("should resolve false when the watch ends before Studio opened the place", async () => {
		expect.assertions(2);

		const watch = watching();
		const onOpen = vi.fn<() => void>();
		const closed = waitForStudioCloseAsync(watch.options, ANY_STUDIO, onOpen);
		await flushAsync();
		watch.abort.abort();

		await expect(closed).resolves.toBeFalse();
		expect(onOpen).not.toHaveBeenCalled();
	});

	it("should resolve false when the watch ends while Studio has the place open", async () => {
		expect.assertions(2);

		const watch = watching({ "game.rbxl.lock": "1" });
		const onOpen = vi.fn<() => void>();
		const closed = waitForStudioCloseAsync(watch.options, ANY_STUDIO, onOpen);
		await flushAsync();
		watch.abort.abort();

		await expect(closed).resolves.toBeFalse();
		expect(onOpen).toHaveBeenCalledOnce();
	});

	it("should wait for a lock file that names the recorded Studio, not an old one", async () => {
		expect.assertions(2);

		const watch = watching({ "game.rbxl.lock": "3\nRobloxStudioBeta\nhost\n" });
		const onOpen = vi.fn<() => void>();
		const closed = waitForStudioCloseAsync(watch.options, STUDIO_7, onOpen);
		await watch.tickAsync();

		expect(onOpen).not.toHaveBeenCalled();

		watch.memory.fileSystem.writeFileSync(LOCK, "7\nRobloxStudioBeta\nhost\n");
		await watch.tickAsync();
		watch.abort.abort();
		await closed;

		expect(onOpen).toHaveBeenCalledOnce();
	});

	it("should resolve true once the lock file names another process", async () => {
		expect.assertions(1);

		const watch = watching({ "game.rbxl.lock": "7" });
		const closed = waitForStudioCloseAsync(watch.options, STUDIO_7, vi.fn<() => void>());
		await watch.tickAsync();
		watch.memory.fileSystem.writeFileSync(LOCK, "8");
		await watch.tickAsync();

		await expect(closed).resolves.toBeTrue();
	});

	it("should resolve true once the recorded Studio's lock file went away", async () => {
		expect.assertions(1);

		const watch = watching({ "game.rbxl.lock": "7" });
		const closed = waitForStudioCloseAsync(watch.options, STUDIO_7, vi.fn<() => void>());
		await watch.tickAsync();
		watch.memory.fileSystem.rmSync(LOCK);
		await watch.tickAsync();

		await expect(closed).resolves.toBeTrue();
	});
});

describe(watchSaves, () => {
	it("should call onSave once per write, not for the file as it was", async () => {
		expect.assertions(2);

		const watch = watching({ "game.rbxl": "v1" });
		const onSave = vi.fn<() => void>();
		const { done } = watchSaves(watch.options, PLACE, onSave);
		await watch.tickAsync();

		expect(onSave).not.toHaveBeenCalled();

		watch.memory.setModifiedTime("game.rbxl", 5000);
		await watch.tickAsync();
		await watch.tickAsync();
		watch.memory.fileSystem.writeFileSync(PLACE, "longer");
		await watch.tickAsync();
		watch.abort.abort();
		await done;

		expect(onSave).toHaveBeenCalledTimes(2);
	});

	it("should see a place that did not exist at the start", async () => {
		expect.assertions(1);

		const watch = watching();
		const onSave = vi.fn<() => void>();
		const { done } = watchSaves(watch.options, PLACE, onSave);
		watch.memory.fileSystem.writeFileSync(PLACE, "v1");
		await watch.tickAsync();
		watch.abort.abort();
		await done;

		expect(onSave).toHaveBeenCalledOnce();
	});

	it("should look at the file between two polls on check", async () => {
		expect.assertions(2);

		const watch = watching({ "game.rbxl": "v1" });
		const onSave = vi.fn<() => void>();
		const { check, done } = watchSaves(watch.options, PLACE, onSave);
		check();

		expect(onSave).not.toHaveBeenCalled();

		watch.memory.fileSystem.writeFileSync(PLACE, "saved");
		check();
		watch.abort.abort();
		await done;

		expect(onSave).toHaveBeenCalledOnce();
	});
});
