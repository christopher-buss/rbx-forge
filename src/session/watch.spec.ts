import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createManualClock } from "../../test/helpers/manual-clock.ts";
import type { ManualClock } from "../../test/helpers/manual-clock.ts";
import { createMemoryFileSystem, PROJECT } from "../../test/helpers/seams.ts";
import type { MemoryFileSystem } from "../../test/helpers/seams.ts";
import type { WatchOptions } from "./watch.ts";
import { waitForStudioCloseAsync, watchSavesAsync } from "./watch.ts";

const PLACE = path.join(PROJECT, "game.rbxl");
const LOCK = `${PLACE}.lock`;

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
		const closed = waitForStudioCloseAsync(watch.options, LOCK, onOpen);
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
		const closed = waitForStudioCloseAsync(watch.options, LOCK, onOpen);
		await flushAsync();
		watch.abort.abort();

		await expect(closed).resolves.toBeFalse();
		expect(onOpen).not.toHaveBeenCalled();
	});

	it("should resolve false when the watch ends while Studio has the place open", async () => {
		expect.assertions(2);

		const watch = watching({ "game.rbxl.lock": "1" });
		const onOpen = vi.fn<() => void>();
		const closed = waitForStudioCloseAsync(watch.options, LOCK, onOpen);
		await flushAsync();
		watch.abort.abort();

		await expect(closed).resolves.toBeFalse();
		expect(onOpen).toHaveBeenCalledOnce();
	});
});

describe(watchSavesAsync, () => {
	it("should call onSave once per write, not for the file as it was", async () => {
		expect.assertions(2);

		const watch = watching({ "game.rbxl": "v1" });
		const onSave = vi.fn<() => void>();
		const done = watchSavesAsync(watch.options, PLACE, onSave);
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
		const done = watchSavesAsync(watch.options, PLACE, onSave);
		watch.memory.fileSystem.writeFileSync(PLACE, "v1");
		await watch.tickAsync();
		watch.abort.abort();
		await done;

		expect(onSave).toHaveBeenCalledOnce();
	});
});
