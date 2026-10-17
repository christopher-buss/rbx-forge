import { fromPartial } from "@total-typescript/shoehorn";

import { assert, describe, it } from "vitest";

import { makeStatus } from "../../test/helpers/fake-session.ts";
import { createManualClock } from "../../test/helpers/manual-clock.ts";
import type { SaveMethod } from "../config/schema.ts";
import { ForgeError } from "../errors.ts";
import { createPartRequests } from "../session/part-requests.ts";
import type { PartHandlers } from "../session/part-requests.ts";
import type { StudioSave } from "../studio/save-studio.ts";
import { controlHandlers } from "./control.ts";

const SAVED: StudioSave = {
	bytes: 12,
	desktop: "hidden",
	durationMs: 300,
	method: "menu",
	mtime: "2026-01-01T00:00:00.000Z",
	pid: 42,
	place: "/project/game.rbxl",
};

function saveControl(save?: PartHandlers["save"], saveMethod?: SaveMethod) {
	const manual = createManualClock();
	const parts = createPartRequests();
	parts.attach(fromPartial({ save }));
	const handlers = controlHandlers(
		fromPartial({
			clock: manual.clock,
			parts,
			saveMethod,
			sessionId: "s1",
			status: { snapshot: makeStatus },
		}),
	);
	assert(handlers.save !== undefined);
	return { manual, save: handlers.save };
}

describe("session save control", () => {
	it("bounds a capture whose handler does not settle after cancellation", async ({ expect }) => {
		expect.assertions(3);

		let isAborted = false;
		const { manual, save } = saveControl(async (_timeoutMs, signal) => {
			return new Promise(() => {
				signal!.addEventListener("abort", () => {
					isAborted = true;
				});
			});
		}, "capture");
		const rejected = Promise.resolve(save({ timeoutMs: 1000 })).catch((err: unknown) => err);
		await new Promise<void>((resolve) => {
			setImmediate(resolve);
		});
		manual.advance(1000);
		await new Promise<void>((resolve) => {
			setImmediate(resolve);
		});

		expect(isAborted).toBeTrue();

		manual.advance(0);

		await expect(rejected).resolves.toMatchObject({ code: "capture_timeout" });
		expect(manual.pending()).toBe(0);
	});

	it("keeps the listener's disconnected error when the capture deadline aborts it", async ({
		expect,
	}) => {
		expect.assertions(2);

		const { manual, save } = saveControl(async (_timeoutMs, signal) => {
			return new Promise((_resolve, reject) => {
				signal!.addEventListener("abort", () => {
					reject(
						new ForgeError(
							"capture_not_connected",
							"Connect Studio to the session's Rojo.",
						),
					);
				});
			});
		}, "capture");
		const rejected = Promise.resolve(save({ timeoutMs: 1000 })).catch((err: unknown) => err);
		await new Promise<void>((resolve) => {
			setImmediate(resolve);
		});
		manual.advance(1000);

		await expect(rejected).resolves.toMatchObject({ code: "capture_not_connected" });
		expect(manual.pending()).toBe(0);
	});

	it("reports a capture deadline without using the menu save error code", async ({ expect }) => {
		expect.assertions(1);

		const pending = Promise.withResolvers<StudioSave>();
		const { manual, save } = saveControl(async () => pending.promise, "capture");
		const saving = Promise.resolve(save({ timeoutMs: 1000 }));
		const rejected = saving.catch((err: unknown) => err);
		manual.advance(1000);
		pending.resolve(SAVED);

		await expect(rejected).resolves.toMatchObject({
			code: "capture_timeout",
			details: { reason: "timeout" },
		});
	});

	it("keeps returned capture warnings when the control deadline expires", async ({ expect }) => {
		expect.assertions(1);

		const pending = Promise.withResolvers<StudioSave>();
		const { manual, save } = saveControl(async () => pending.promise, "capture");
		const rejected = Promise.resolve(save({ timeoutMs: 1000 })).catch((err: unknown) => err);
		manual.advance(1000);
		pending.resolve({
			...SAVED,
			warnings: [
				{ property: "StreamingTargetRadius", reason: "unreadable", service: "Workspace" },
			],
		});

		await expect(rejected).resolves.toMatchObject({
			code: "capture_timeout",
			details: {
				captureWarnings: [
					{
						property: "StreamingTargetRadius",
						reason: "unreadable",
						service: "Workspace",
					},
				],
				reason: "timeout",
			},
			message: "Studio did not save before the timeout.",
		});
	});

	it.for([undefined, "100", NaN, Infinity, 0, -1])(
		"rejects the invalid save deadline %s before saving",
		async (timeoutMs, { expect }) => {
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

	it("refuses a save for a replaced session", async ({ expect }) => {
		expect.assertions(1);

		const { save } = saveControl(async () => SAVED);

		await expect(save({ sessionId: "old", timeoutMs: 1000 })).rejects.toMatchObject({
			code: "session_replaced",
		});
	});

	it("returns saved metadata and cancels its deadline after success", async ({ expect }) => {
		expect.assertions(2);

		const { manual, save } = saveControl(async () => SAVED);

		await expect(save({ sessionId: "s1", timeoutMs: 1000 })).resolves.toStrictEqual(SAVED);
		expect(manual.pending()).toBe(0);
	});

	it("returns the save failure and cancels its deadline", async ({ expect }) => {
		expect.assertions(2);

		const { manual, save } = saveControl(async () => {
			throw new ForgeError("studio_busy", "A modal dialog blocks Roblox Studio.");
		});

		await expect(save({ timeoutMs: 1000 })).rejects.toMatchObject({ code: "studio_busy" });
		expect(manual.pending()).toBe(0);
	});

	it("reports no Studio when the session has no save handler", async ({ expect }) => {
		expect.assertions(1);

		const { save } = saveControl();

		await expect(save({ timeoutMs: 1000 })).rejects.toMatchObject({
			code: "studio_not_open",
			message: "No session Studio is open.",
		});
	});

	it("expires at its deadline and cancels the action before it can change the place", async ({
		expect,
	}) => {
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
