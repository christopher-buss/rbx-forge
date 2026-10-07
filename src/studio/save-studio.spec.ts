import path from "node:path";
import { assert, describe, expect, it } from "vitest";

import type { FakeProcess } from "../../test/helpers/native.ts";
import { createFakeNative } from "../../test/helpers/native.ts";
import {
	createMemoryFileSystem,
	createTestSeams,
	PROJECT,
	TEST_HOSTNAME,
} from "../../test/helpers/seams.ts";
import { PRIME_LIMIT_MS, saveStudioAsync } from "./save-studio.ts";

const PLACE = path.join(PROJECT, "game.rbxl");

/**
 * A Studio whose Save to File is disabled until it has been active, and a
 * frontmost editor (PID 7).
 *
 * @param studio - Overrides for the Studio entry.
 * @param script - What happens while it primes.
 * @param script.abortsAtSleep - The session ends at this clock sleep.
 * @param script.hidesAtSleep - Something else hides Studio at this clock sleep.
 * @param script.menuReadMs - How long each Save to File read takes.
 * @param script.timeoutMs - The save deadline.
 * @returns The save, the process table, and the clock.
 */
function priming(
	studio: Partial<FakeProcess> = {},
	{
		abortsAtSleep,
		hidesAtSleep,
		menuReadMs = 0,
		timeoutMs = 1000,
	}: {
		abortsAtSleep?: number;
		hidesAtSleep?: number;
		menuReadMs?: number;
		timeoutMs?: number;
	} = {},
) {
	const memory = createMemoryFileSystem({
		"game.rbxl": "place",
		"game.rbxl.lock": `42\nRobloxStudio\n${TEST_HOSTNAME}\n`,
	});
	memory.setModifiedTime("game.rbxl", 1000);
	const native = createFakeNative({
		7: { alive: true, appActive: true, executablePath: "Editor" },
		42: {
			alive: true,
			appHidden: true,
			executablePath: "RobloxStudio",
			onSave: () => {
				memory.setModifiedTime("game.rbxl", 2000);
			},
			saveMenuDisabled: true,
			saveMenuEnablesAtPoll: 3,
			...studio,
		},
	});
	const entry = native.processes.get(42);
	const editor = native.processes.get(7);
	assert(entry !== undefined && editor !== undefined);
	let now = 0;
	let sleeps = 0;
	const abort = new AbortController();
	const { pinProcess } = native.addon;
	/**
	 * Pin a process whose Save to File reads take {@link menuReadMs}.
	 *
	 * @param pid - The process.
	 * @returns The pin, or null.
	 */
	native.addon.pinProcess = (pid) => {
		const pinned = pinProcess(pid);
		return pinned === null
			? null
			: {
					...pinned,
					saveMenuEnabled: async (ms) => {
						now += menuReadMs;
						return pinned.saveMenuEnabled(ms);
					},
				};
	};

	const seams = createTestSeams({
		clock: {
			now: () => now,
			sleep: async (ms) => {
				now += ms;
				sleeps += 1;
				if (sleeps === hidesAtSleep) {
					entry.appHidden = true;
					entry.appActive = false;
				}

				if (sleeps === abortsAtSleep) {
					abort.abort();
				}
			},
		},
		fileSystem: memory.fileSystem,
		native: () => native.addon,
	});
	return {
		editor,
		entry,
		now: () => now,
		save: async () => saveStudioAsync(seams, { place: PLACE }, timeoutMs, abort.signal),
	};
}

describe(saveStudioAsync, () => {
	it("should activate a never-active Studio once, then hide it and refocus the front app before saving", async () => {
		expect.assertions(5);

		const run = priming();

		await expect(run.save()).resolves.toMatchObject({ mtime: "1970-01-01T00:00:02.000Z" });
		expect(run.entry.activations).toBe(1);
		expect(run.entry.appHidden).toBeTrue();
		expect(run.editor.appActive).toBeTrue();
		expect(run.entry.saveMenuPolls).toBe(3);
	});

	it("should leave a visible Studio visible after priming and still refocus the front app", async () => {
		expect.assertions(3);

		const run = priming({ appHidden: false });

		await expect(run.save()).resolves.toMatchObject({ pid: 42 });
		expect(run.entry.appHidden).toBeFalse();
		expect(run.editor.appActive).toBeTrue();
	});

	it("should activate Studio again when something hides it while it primes", async () => {
		expect.assertions(2);

		const run = priming({}, { hidesAtSleep: 1 });

		await expect(run.save()).resolves.toMatchObject({ pid: 42 });
		expect(run.entry.activations).toBe(2);
	});

	it("should report menu_disabled and restore hidden state and focus at the priming limit", async () => {
		expect.assertions(4);

		const run = priming({ saveMenuEnablesAtPoll: Infinity }, { timeoutMs: 30_000 });

		await expect(run.save()).rejects.toMatchObject({
			code: "save_failed",
			details: { place: PLACE, reason: "menu_disabled" },
		});
		expect(run.now()).toBe(PRIME_LIMIT_MS);
		expect(run.entry.appHidden).toBeTrue();
		expect(run.editor.appActive).toBeTrue();
	});

	it("should report a timeout when the save deadline passes before the priming limit", async () => {
		expect.assertions(3);

		const run = priming({ saveMenuEnablesAtPoll: Infinity }, { timeoutMs: PRIME_LIMIT_MS / 2 });

		await expect(run.save()).rejects.toMatchObject({
			code: "save_failed",
			details: { place: PLACE, reason: "timeout" },
		});
		expect(run.entry.appHidden).toBeTrue();
		expect(run.editor.appActive).toBeTrue();
	});

	it("should report a timeout when Save to File enables only at the save deadline", async () => {
		expect.assertions(2);

		const run = priming({ saveMenuEnablesAtPoll: 1 }, { menuReadMs: 1000 });

		await expect(run.save()).rejects.toMatchObject({
			code: "save_failed",
			details: { place: PLACE, reason: "timeout" },
		});
		expect(run.entry.appHidden).toBeTrue();
	});

	it("should restore hidden state and focus when the session ends while Studio primes", async () => {
		expect.assertions(3);

		const run = priming({ saveMenuEnablesAtPoll: Infinity }, { abortsAtSleep: 2 });

		await expect(run.save()).rejects.toMatchObject({ cause: { name: "AbortError" } });
		expect(run.entry.appHidden).toBeTrue();
		expect(run.editor.appActive).toBeTrue();
	});

	it("should not activate Studio again when it was already the front app", async () => {
		expect.assertions(3);

		const run = priming({ appActive: true, appHidden: false });
		run.editor.appActive = false;

		await expect(run.save()).resolves.toMatchObject({ pid: 42 });
		expect(run.entry.activations).toBeUndefined();
		expect(run.entry.appHidden).toBeFalse();
	});

	it("should hide Studio again when no app was frontmost", async () => {
		expect.assertions(3);

		const run = priming();
		run.editor.appActive = false;

		await expect(run.save()).resolves.toMatchObject({ pid: 42 });
		expect(run.entry.appHidden).toBeTrue();
		expect(run.editor.appActive).toBeFalse();
	});

	it("should save without priming when Save to File is enabled", async () => {
		expect.assertions(2);

		const run = priming({ saveMenuDisabled: false });

		await expect(run.save()).resolves.toMatchObject({ pid: 42 });
		expect(run.entry.activations).toBeUndefined();
	});
});
