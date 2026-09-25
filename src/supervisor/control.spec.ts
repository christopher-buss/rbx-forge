import { describe, expect, it, vi } from "vitest";

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
	return {
		handlers: controlHandlers({ sessionId: "s1", status, stop: { request } }),
		request,
		status,
	};
}

describe(controlHandlers, () => {
	it("should answer status with the status now", () => {
		expect.assertions(1);

		const { handlers, status } = makeTarget();

		expect(handlers.status!({})).toStrictEqual(status.snapshot());
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
});
