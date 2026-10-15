import { fromPartial } from "@total-typescript/shoehorn";

import { assert, describe, it } from "vitest";

import { createManualClock } from "../../test/helpers/manual-clock.ts";
import type { CaptureWarning } from "../capture/protocol.ts";
import { ForgeError } from "../errors.ts";
import { createPartRequests } from "../session/part-requests.ts";
import type { PartHandlers } from "../session/part-requests.ts";
import { createSessionSync } from "../session/session-sync.ts";
import type { SyncbackAttempt } from "../session/session-sync.ts";
import type { StudioSave } from "../studio/save-studio.ts";
import { controlHandlers } from "./control.ts";

const SAVED: StudioSave = {
	bytes: 12,
	desktop: "user",
	durationMs: 3,
	method: "capture",
	mtime: "2026-01-01T00:00:00.000Z",
	pid: 42,
	place: "/project/game.rbxl",
};

function captureWhileIdle(release: Promise<void>): NonNullable<PartHandlers["save"]> {
	let isCapturing = false;
	return async () => {
		if (isCapturing) {
			throw new ForgeError("capture_rejected", "The plugin is already capturing.");
		}

		isCapturing = true;
		await release;
		isCapturing = false;
		return SAVED;
	};
}

describe("capture-based sync control", () => {
	it("preserves a syncback failure when the capture has no warnings", async ({ expect }) => {
		expect.assertions(1);

		const failure = new ForgeError("process_failed", "Rojo exited.", {
			details: { exitCode: 2 },
		});
		const parts = createPartRequests();
		parts.attach(fromPartial({ save: async () => SAVED }));
		const sync = createSessionSync();
		sync.attach(async () => ({ error: failure, ok: false }));
		const handlers = controlHandlers(
			fromPartial({
				clock: createManualClock().clock,
				parts,
				saveMethod: "capture",
				sessionId: "s1",
				sync,
			}),
		);
		assert(handlers.sync !== undefined);

		await expect(handlers.sync({})).rejects.toBe(failure);
	});

	it("keeps consumed capture warnings when a syncback hook fails", async ({ expect }) => {
		expect.assertions(2);

		const warning = {
			property: "StreamingTargetRadius",
			reason: "unreadable",
			service: "Workspace",
		} satisfies CaptureWarning;
		const captures = [
			{ ...SAVED, warnings: [warning] },
			{ ...SAVED, warnings: [] },
		];
		const parts = createPartRequests();
		parts.attach(
			fromPartial({
				save: async () => {
					const capture = captures.shift();
					assert(capture !== undefined);
					return capture;
				},
			}),
		);
		let attempt: SyncbackAttempt = {
			error: new ForgeError("hook_failed", "Lint failed.", {
				details: { hooks: [] },
				hint: "Fix the hook.",
			}),
			ok: false,
		};
		const sync = createSessionSync();
		sync.attach(async () => attempt);
		const handlers = controlHandlers(
			fromPartial({
				clock: createManualClock().clock,
				parts,
				saveMethod: "capture",
				sessionId: "s1",
				sync,
			}),
		);
		assert(handlers.sync !== undefined);

		await expect(handlers.sync({})).rejects.toMatchObject({
			code: "hook_failed",
			details: { captureWarnings: [warning], hooks: [] },
			hint: "Fix the hook.",
			message: "Lint failed.",
		});

		attempt = {
			hooks: [],
			ok: true,
			value: { durationMs: 1, input: SAVED.place, project: "default.project.json" },
		};

		await expect(handlers.sync({})).resolves.toMatchObject({ capture: { warnings: [] } });
	});

	it("shares one capture queue between an explicit save and sync", async ({ expect }) => {
		expect.assertions(1);

		const release = Promise.withResolvers<void>();
		const parts = createPartRequests();
		parts.attach(fromPartial({ save: captureWhileIdle(release.promise) }));
		const handlers = controlHandlers(
			fromPartial({
				clock: createManualClock().clock,
				parts,
				saveMethod: "capture",
				sessionId: "s1",
				sync: { runAsync: async () => ({ input: SAVED.place }) },
			}),
		);
		assert(handlers.save !== undefined);
		assert(handlers.sync !== undefined);
		const saving = handlers.save({ timeoutMs: 1000 });
		await new Promise<void>((resolve) => {
			setImmediate(resolve);
		});
		const syncing = handlers.sync({});
		await new Promise<void>((resolve) => {
			setImmediate(resolve);
		});
		release.resolve();

		await expect(Promise.all([saving, syncing])).resolves.toStrictEqual([
			SAVED,
			{ capture: SAVED, input: SAVED.place },
		]);
	});

	it("syncs the current Studio capture before returning the syncback result", async ({
		expect,
	}) => {
		expect.assertions(2);

		const parts = createPartRequests();
		let place = "old place";
		let project = "old source";
		parts.attach(
			fromPartial({
				save: async () => {
					place = "Studio edit";
					return SAVED;
				},
			}),
		);
		const handlers = controlHandlers(
			fromPartial({
				clock: createManualClock().clock,
				parts,
				saveMethod: "capture",
				sessionId: "s1",
				sync: {
					runAsync: async () => {
						project = place;
						return {
							durationMs: 4,
							hooks: [],
							input: SAVED.place,
							project: "default.project.json",
						};
					},
				},
			}),
		);
		assert(handlers.sync !== undefined);
		const result = await handlers.sync({});

		expect(project).toBe("Studio edit");
		expect(result).toStrictEqual({
			capture: SAVED,
			durationMs: 4,
			hooks: [],
			input: SAVED.place,
			project: "default.project.json",
		});
	});
});
