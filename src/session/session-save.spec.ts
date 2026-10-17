import { fromPartial } from "@total-typescript/shoehorn";

import path from "node:path";
import { assert, describe, it } from "vitest";

import { createFakeCapture } from "../../test/helpers/fake-capture.ts";
import { makeStatus } from "../../test/helpers/fake-session.ts";
import { createManualClock } from "../../test/helpers/manual-clock.ts";
import {
	createCommandContext,
	createMemoryFileSystem,
	createTestSeams,
	PROJECT,
} from "../../test/helpers/seams.ts";
import type { Capture } from "../capture/protocol.ts";
import { resolveConfig } from "../config/resolve.ts";
import { nodeClock } from "../seams/clock.ts";
import { createIdleTracker } from "./idle.ts";
import { saveSessionStudioAsync } from "./session-save.ts";

describe(saveSessionStudioAsync, () => {
	it("reports a disconnected capture plugin without changing the Studio", async ({ expect }) => {
		expect.assertions(1);

		const status = makeStatus();
		status.services.studio = { owner: null, place: "game.rbxl", status: "open" };

		await expect(
			saveSessionStudioAsync(
				{
					config: resolveConfig(
						{ projectType: "luau", studio: { saveMethod: "capture" } },
						{},
					),
					context: createCommandContext(),
					idle: createIdleTracker(1, 0),
					status: fromPartial({ snapshot: () => status }),
				},
				{ signal: AbortSignal.any([]) },
				1000,
			),
		).rejects.toMatchObject({
			code: "capture_not_connected",
			message: "The forge plugin is not connected; connect Studio to the session's Rojo.",
		});
	});

	it("writes a plugin capture to the syncback input without a Studio menu save", async ({
		expect,
	}) => {
		expect.assertions(3);

		const memory = createMemoryFileSystem({ "game.rbxl": "old place", "tools/rojo": "" });
		const place = path.join(PROJECT, "game.rbxl");
		const manual = createManualClock(5000);
		const status = makeStatus();
		status.services.studio = { owner: null, pid: 42, place, startTime: "42", status: "open" };
		const context = createCommandContext({
			env: { PATH: path.join(PROJECT, "tools") },
			seams: createTestSeams({
				clock: manual.clock,
				fileSystem: memory.fileSystem,
				native: () => {
					return fromPartial({
						assemblePlace: (
							_base: string,
							_model: Uint8Array,
							_services: string,
							output: string,
						) => {
							memory.fileSystem.writeFileSync(output, "captured place");
						},
					});
				},
				processRunner: async (spec) => {
					assert(spec.timeoutMs !== undefined && spec.timeoutMs >= 25);
					const durationMs = 25;
					manual.advance(durationMs);
					return {
						durationMs,
						exitCode: 0,
						outputTail: [],
						signal: null,
						type: "exited",
					};
				},
				randomId: () => "capture-test",
			}),
		});
		const payload: Capture = {
			model: new Uint8Array([1]),
			services: [],
			warnings: [
				{ property: "StreamingTargetRadius", reason: "unreadable", service: "Workspace" },
			],
		};
		const saved = await saveSessionStudioAsync(
			{
				capture: {
					...createFakeCapture(payload),
					captureAsync: async (signal) => {
						await nodeClock.sleep(20, signal);
						manual.advance(20);
						return payload;
					},
					rojoPort: 34872,
				},
				config: resolveConfig(
					{ projectType: "luau", studio: { saveMethod: "capture" } },
					{},
				),
				context,
				idle: createIdleTracker(1, 0),
				status: fromPartial({ snapshot: () => status }),
			},
			{ signal: AbortSignal.any([]) },
			10_000,
		);

		expect(memory.files()["game.rbxl"]).toBe("captured place");
		expect(saved).toMatchObject({ bytes: 14, durationMs: 45, pid: 42, place });
		expect(saved.warnings).toStrictEqual([
			{ property: "StreamingTargetRadius", reason: "unreadable", service: "Workspace" },
		]);
	});

	it.for(["request", "session"] as const)(
		"cancels an in-flight plugin capture when its %s ends",
		async (kind, { expect, onTestFinished }) => {
			expect.assertions(1);

			const memory = createMemoryFileSystem({ "tools/rojo": "" });
			const status = makeStatus();
			status.services.studio = { owner: null, place: "game.rbxl", status: "open" };
			const request = new AbortController();
			const scope = new AbortController();
			onTestFinished(() => {
				request.abort();
				scope.abort();
			});
			const requested = Promise.withResolvers<void>();
			const saving = saveSessionStudioAsync(
				{
					capture: {
						...createFakeCapture({ model: new Uint8Array(), services: [] }),
						captureAsync: async (signal) => {
							const stopped = Promise.withResolvers<never>();
							signal.addEventListener(
								"abort",
								() => {
									stopped.reject(signal.reason);
								},
								{ once: true },
							);
							requested.resolve();
							return stopped.promise;
						},
						rojoPort: 34872,
					},
					config: resolveConfig(
						{ projectType: "luau", studio: { saveMethod: "capture" } },
						{},
					),
					context: createCommandContext({
						env: { PATH: path.join(PROJECT, "tools") },
						seams: createTestSeams({
							fileSystem: memory.fileSystem,
							processRunner: async () => {
								return {
									durationMs: 0,
									exitCode: 0,
									outputTail: [],
									signal: null,
									type: "exited",
								};
							},
							randomId: () => "cancelled-capture",
						}),
					}),
					idle: createIdleTracker(1, 0),
					status: fromPartial({ snapshot: () => status }),
				},
				{ signal: scope.signal },
				10_000,
				request.signal,
			);
			const rejected = saving.catch((err: unknown) => err);
			await Promise.race([requested.promise, saving]);
			({ request, session: scope })[kind].abort();

			await expect(rejected).resolves.toMatchObject({ name: "AbortError" });
		},
	);

	it("rejects an ended session before looking for Studio", async ({ expect }) => {
		expect.assertions(1);

		await expect(
			saveSessionStudioAsync(
				{
					context: createCommandContext(),
					idle: createIdleTracker(1, 0),
					status: fromPartial({ snapshot: makeStatus }),
				},
				{ signal: AbortSignal.abort() },
				1000,
			),
		).rejects.toMatchObject({ name: "AbortError" });
	});

	it.for(["stopped", "stopping"] as const)(
		"rejects saving a %s session",
		async (phase, { expect }) => {
			expect.assertions(1);

			await expect(
				saveSessionStudioAsync(
					{
						context: createCommandContext(),
						idle: createIdleTracker(1, 0),
						status: fromPartial({ snapshot: () => makeStatus({ phase }) }),
					},
					{ signal: AbortSignal.any([]) },
					1000,
				),
			).rejects.toMatchObject({
				code: "not_running",
				message: "The session is stopping.",
			});
		},
	);

	it.for(["off", "closed", "open"] as const)(
		"rejects an unavailable %s Studio",
		async (status, { expect }) => {
			expect.assertions(1);

			const session = makeStatus();
			session.services.studio.status = status;
			const places = {
				closed: { place: "saved.rbxl" },
				off: { place: "saved.rbxl" },
				open: {},
			};
			session.services.studio = { ...session.services.studio, ...places[status] };

			await expect(
				saveSessionStudioAsync(
					{
						context: createCommandContext(),
						idle: createIdleTracker(1, 0),
						status: fromPartial({ snapshot: () => session }),
					},
					{ signal: AbortSignal.any([]) },
					1000,
				),
			).rejects.toMatchObject({
				code: "studio_not_open",
				message: "No session Studio is open.",
			});
		},
	);

	it("counts opening time against the save deadline and resets idle activity on failure", async ({
		expect,
	}) => {
		expect.assertions(3);

		const manual = createManualClock(5000);
		const session = makeStatus();
		session.services.studio.status = "opening";
		const idle = createIdleTracker(1, 0);
		const saving = saveSessionStudioAsync(
			{
				context: createCommandContext({ seams: createTestSeams({ clock: manual.clock }) }),
				idle,
				status: fromPartial({ snapshot: () => session }),
			},
			{ signal: AbortSignal.any([]) },
			100,
		);

		expect(idle.idleAt()).toBe(65_000);

		const rejected = saving.catch((err: unknown) => err);
		manual.advance(100);

		await expect(rejected).resolves.toMatchObject({
			code: "save_failed",
			details: { reason: "timeout" },
			message: "Studio did not save before the timeout.",
		});
		expect(idle.idleAt()).toBe(65_100);
	});

	it.for(["request", "session"] as const)(
		"cancels an opening wait when its %s ends",
		async (kind, { expect }) => {
			expect.assertions(1);

			const manual = createManualClock();
			const session = makeStatus();
			session.services.studio.status = "opening";
			const request = new AbortController();
			const scope = new AbortController();
			const saving = saveSessionStudioAsync(
				{
					context: createCommandContext({
						seams: createTestSeams({ clock: manual.clock }),
					}),
					idle: createIdleTracker(1, 0),
					status: fromPartial({ snapshot: () => session }),
				},
				{ signal: scope.signal },
				1000,
				request.signal,
			);
			const rejected = saving.catch((err: unknown) => err);
			await Promise.resolve();
			({ request, session: scope })[kind].abort();

			await expect(rejected).resolves.toMatchObject({ name: "AbortError" });
		},
	);
});
