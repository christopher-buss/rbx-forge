import { fromPartial } from "@total-typescript/shoehorn";

import { describe, expect, it } from "vitest";

import { makeStatus } from "../../test/helpers/fake-session.ts";
import { createManualClock } from "../../test/helpers/manual-clock.ts";
import { createCommandContext, createTestSeams } from "../../test/helpers/seams.ts";
import { createIdleTracker } from "./idle.ts";
import { saveSessionStudioAsync } from "./session-save.ts";

describe(saveSessionStudioAsync, () => {
	it("rejects an ended session before looking for Studio", async () => {
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

	it.for(["stopped", "stopping"] as const)("rejects saving a %s session", async (phase) => {
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
	});

	it.for(["off", "closed", "open"] as const)(
		"rejects an unavailable %s Studio",
		async (status) => {
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

	it("counts opening time against the save deadline and resets idle activity on failure", async () => {
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
		async (kind) => {
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
