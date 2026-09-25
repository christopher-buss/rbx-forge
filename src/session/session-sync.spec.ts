import { describe, expect, it } from "vitest";

import { ForgeError } from "../errors.ts";
import type { SyncbackAttempt } from "./session-sync.ts";
import { createSessionSync } from "./session-sync.ts";

const SYNCED: SyncbackAttempt = {
	hooks: [],
	ok: true,
	value: { durationMs: 12, input: "/project/game.rbxl", project: "default.project.json" },
};

async function flushAsync(): Promise<void> {
	await new Promise((resolve) => {
		setImmediate(resolve);
	});
}

describe(createSessionSync, () => {
	it("should answer with what syncback synced and its hooks", async () => {
		expect.assertions(1);

		const sync = createSessionSync();
		sync.attach(async () => SYNCED);

		await expect(sync.runAsync()).resolves.toStrictEqual({
			durationMs: 12,
			hooks: [],
			input: "/project/game.rbxl",
			project: "default.project.json",
		});
	});

	it("should wait for syncback to be ready when asked while the session starts", async () => {
		expect.assertions(2);

		const sync = createSessionSync();
		let isAnswered = false;
		const answer = sync.runAsync().then((result) => {
			isAnswered = true;
			return result;
		});
		await flushAsync();
		const wasAnswered = isAnswered;
		sync.attach(async () => SYNCED);

		expect(wasAnswered).toBeFalse();
		await expect(answer).resolves.toMatchObject({ input: "/project/game.rbxl" });
	});

	it("should reject with the run's error, its code and details kept", async () => {
		expect.assertions(1);

		const sync = createSessionSync();
		const error = new ForgeError("hook_failed", "lint failed.", {
			details: { hooks: [] },
		});
		sync.attach(async () => ({ error, ok: false }));

		await expect(sync.runAsync()).rejects.toMatchObject({
			code: "hook_failed",
			details: { hooks: [] },
			message: "lint failed.",
		});
	});

	it("should reject a request waiting for syncback once the session is stopping", async () => {
		expect.assertions(1);

		const sync = createSessionSync();
		const pending = sync.runAsync();
		sync.close();
		sync.attach(async () => SYNCED);

		await expect(pending).rejects.toMatchObject({
			code: "not_running",
			hint: 'Start a session with "forge up", or run "forge syncback".',
			message: "The session is stopping; it runs no more syncback.",
		});
	});

	it("should reject a request after the close even when syncback was ready", async () => {
		expect.assertions(1);

		const sync = createSessionSync();
		sync.attach(async () => SYNCED);
		sync.close();

		await expect(sync.runAsync()).rejects.toMatchObject({ code: "not_running" });
	});
});
