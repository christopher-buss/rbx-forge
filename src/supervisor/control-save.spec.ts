import { fromPartial } from "@total-typescript/shoehorn";

import { assert, describe, expect, it } from "vitest";

import { makeStatus } from "../../test/helpers/fake-session.ts";
import { createManualClock } from "../../test/helpers/manual-clock.ts";
import { ForgeError } from "../errors.ts";
import { createPartRequests } from "../session/part-requests.ts";
import type { PartHandlers } from "../session/part-requests.ts";
import type { StudioSave } from "../studio/save-studio.ts";
import { controlHandlers } from "./control.ts";

const SAVED: StudioSave = {
	bytes: 12,
	desktop: "hidden",
	durationMs: 300,
	mtime: "2026-01-01T00:00:00.000Z",
	pid: 42,
	place: "/project/game.rbxl",
};

function saveControl(save?: PartHandlers["save"]) {
	const manual = createManualClock();
	const parts = createPartRequests();
	parts.attach(fromPartial({ save }));
	const handlers = controlHandlers(
		fromPartial({
			clock: manual.clock,
			parts,
			sessionId: "s1",
			status: { snapshot: makeStatus },
		}),
	);
	assert(handlers.save !== undefined);
	return { manual, save: handlers.save };
}

describe("session save control", () => {
	it.for([undefined, "100", NaN, Infinity, 0, -1])(
		"rejects the invalid save deadline %s before saving",
		async (timeoutMs) => {
			expect.assertions(1);

			const { save } = saveControl(async () => {
				throw new Error("An invalid deadline reached Studio.");
			});

			await expect(save({ timeoutMs })).rejects.toMatchObject({
				code: "usage",
				message: "save takes a positive timeoutMs.",
			});
		},
	);

	it("refuses a save for a replaced session", async () => {
		expect.assertions(1);

		const { save } = saveControl(async () => SAVED);

		await expect(save({ sessionId: "old", timeoutMs: 1000 })).rejects.toMatchObject({
			code: "session_replaced",
		});
	});

	it("returns saved metadata and cancels its deadline after success", async () => {
		expect.assertions(2);

		const { manual, save } = saveControl(async () => SAVED);

		await expect(save({ sessionId: "s1", timeoutMs: 1000 })).resolves.toStrictEqual(SAVED);
		expect(manual.pending()).toBe(0);
	});

	it("returns the save failure and cancels its deadline", async () => {
		expect.assertions(2);

		const { manual, save } = saveControl(async () => {
			throw new ForgeError("studio_busy", "A modal dialog blocks Roblox Studio.");
		});

		await expect(save({ timeoutMs: 1000 })).rejects.toMatchObject({ code: "studio_busy" });
		expect(manual.pending()).toBe(0);
	});

	it("reports no Studio when the session has no save handler", async () => {
		expect.assertions(1);

		const { save } = saveControl();

		await expect(save({ timeoutMs: 1000 })).rejects.toMatchObject({
			code: "studio_not_open",
			message: "No session Studio is open.",
		});
	});

	it("expires at its deadline and cancels the action before it can change the place", async () => {
		expect.assertions(4);

		const release = Promise.withResolvers<void>();
		let contents = "unsaved";
		const { manual, save } = saveControl(async (_timeoutMs, signal) => {
			await release.promise;
			signal!.throwIfAborted();
			contents = "saved";
			return SAVED;
		});
		const saving = Promise.resolve(save({ timeoutMs: 1000 }));
		const rejected = saving.catch((err: unknown) => err);
		manual.advance(999);
		await Promise.resolve();

		expect(contents).toBe("unsaved");
		expect(manual.pending()).toBe(1);

		manual.advance(1);

		await expect(rejected).resolves.toMatchObject({
			code: "save_failed",
			details: { reason: "timeout" },
			message: "Studio did not save before the timeout.",
		});

		release.resolve();
		await new Promise<void>((resolve) => {
			setImmediate(resolve);
		});

		expect(contents).toBe("unsaved");
	});
});
