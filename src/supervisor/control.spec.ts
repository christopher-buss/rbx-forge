import { describe, expect, it, vi } from "vitest";

import { ForgeError } from "../errors.ts";
import type { BuildWatch } from "../session/build-watch.ts";
import { FRESH_BUILD_TIMEOUT_MS } from "../session/build-watch.ts";
import type { SessionSync } from "../session/session-sync.ts";
import type { SessionStatus } from "../session/status.ts";
import { createStatusStore } from "../session/status.ts";
import type { StopRequest } from "../session/stop-source.ts";
import { controlHandlers } from "./control.ts";

function makeTarget() {
	const request = vi.fn<(stop: StopRequest) => void>();
	const status = createStatusStore(
		{
			compiler: false,
			open: false,
			pid: 7,
			port: 1,
			sessionId: "s1",
			startedAt: "2026-01-01T00:00:00.000Z",
			syncback: false,
		},
		() => 0,
		vi.fn<(next: SessionStatus) => void>(),
	);
	const runAsync = vi.fn<SessionSync["runAsync"]>().mockResolvedValue({ input: "game.rbxl" });
	const builds = {
		tick: vi.fn<BuildWatch["tick"]>(),
		waitAsync: vi.fn<BuildWatch["waitAsync"]>().mockResolvedValue(),
	};
	return {
		builds,
		handlers: controlHandlers({
			builds,
			sessionId: "s1",
			status,
			stop: { request },
			sync: { runAsync },
		}),
		request,
		runAsync,
		status,
	};
}

describe(controlHandlers, () => {
	it("should answer status with the status now, once merged compiles settled", () => {
		expect.assertions(2);

		const { builds, handlers, status } = makeTarget();

		expect(handlers.status!({})).toStrictEqual(status.snapshot());
		expect(builds.tick).toHaveBeenCalledOnce();
	});

	it("should answer freshStatus with the status once the build is fresh", async () => {
		expect.assertions(2);

		const { builds, handlers, status } = makeTarget();

		await expect(handlers.freshStatus!({ timeoutMs: 0 })).resolves.toStrictEqual(
			status.snapshot(),
		);
		expect(builds.waitAsync).toHaveBeenCalledExactlyOnceWith(0);
	});

	it.for([[{}], [{ timeoutMs: "5" }], [{ timeoutMs: -1 }]] as const)(
		"should wait the default time for freshStatus params %j",
		async ([parameters]) => {
			expect.assertions(1);

			const { builds, handlers } = makeTarget();
			await handlers.freshStatus!(parameters);

			expect(builds.waitAsync).toHaveBeenCalledExactlyOnceWith(FRESH_BUILD_TIMEOUT_MS);
		},
	);

	it("should fail freshStatus as the wait fails", async () => {
		expect.assertions(1);

		const { builds, handlers } = makeTarget();
		builds.waitAsync.mockRejectedValue(new ForgeError("compile_timeout", "late"));

		await expect(handlers.freshStatus!({})).rejects.toMatchObject({ code: "compile_timeout" });
	});

	it("should stop the session on shutdown, for its own id or none", () => {
		expect.assertions(3);

		const { handlers, request } = makeTarget();

		expect(handlers.shutdown!({})).toStrictEqual({
			accepted: true,
			sessionId: "s1",
		});
		expect(handlers.shutdown!({ sessionId: "s1" })).toStrictEqual({
			accepted: true,
			sessionId: "s1",
		});
		expect(request).toHaveBeenCalledWith({ type: "shutdown" });
	});

	it("should force the shutdown when asked with force", () => {
		expect.assertions(2);

		const { handlers, request } = makeTarget();

		expect(handlers.shutdown!({ force: true, sessionId: "s1" })).toStrictEqual({
			accepted: true,
			sessionId: "s1",
		});
		expect(request).toHaveBeenCalledExactlyOnceWith({ force: true, type: "shutdown" });
	});

	it("should not force the shutdown for a force that is not true", () => {
		expect.assertions(1);

		const { handlers, request } = makeTarget();
		void handlers.shutdown!({ force: "yes" });

		expect(request).toHaveBeenCalledExactlyOnceWith({ type: "shutdown" });
	});

	it("should refuse to stop for another session's id", () => {
		expect.assertions(2);

		const { handlers, request } = makeTarget();

		expect(() => {
			void handlers.shutdown!({ sessionId: "old" });
		}).toThrow(
			expect.objectContaining({
				code: "session_replaced",
				details: { sessionId: "s1" },
				message: "Session old is gone; session s1 runs in its place.",
			}),
		);
		expect(request).not.toHaveBeenCalled();
	});

	it("should answer sync with the session's syncback run", async () => {
		expect.assertions(2);

		const { handlers, runAsync } = makeTarget();

		await expect(handlers.sync!({})).resolves.toStrictEqual({ input: "game.rbxl" });
		expect(runAsync).toHaveBeenCalledOnce();
	});
});
