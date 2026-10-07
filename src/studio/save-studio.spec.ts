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
import { saveStudioAsync } from "./save-studio.ts";

const PLACE = path.join(PROJECT, "game.rbxl");

/**
 * A Studio whose Save to File is disabled until it has been active, and a
 * frontmost editor (PID 7).
 *
 * @param studio - Overrides for the Studio entry.
 * @param hidesAtSleep - Something else hides Studio at this clock sleep.
 * @returns The save, the process table, and the clock.
 */
function priming(studio: Partial<FakeProcess> = {}, hidesAtSleep?: number) {
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
			},
		},
		fileSystem: memory.fileSystem,
		native: () => native.addon,
	});
	return {
		editor,
		entry,
		now: () => now,
		save: async () => saveStudioAsync(seams, { place: PLACE }, 1000),
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

		const run = priming({}, 1);

		await expect(run.save()).resolves.toMatchObject({ pid: 42 });
		expect(run.entry.activations).toBe(2);
	});

	it("should report menu_disabled and restore hidden state and focus when the item never enables", async () => {
		expect.assertions(4);

		const run = priming({ saveMenuEnablesAtPoll: Infinity });

		await expect(run.save()).rejects.toMatchObject({
			code: "save_failed",
			details: { place: PLACE, reason: "menu_disabled" },
		});
		expect(run.now()).toBe(1000);
		expect(run.entry.appHidden).toBeTrue();
		expect(run.editor.appActive).toBeTrue();
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
