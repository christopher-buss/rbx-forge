import { describe, expect, it, vi } from "vitest";

import { ForgeError } from "../errors.ts";
import type { BuildWatch } from "../session/build-watch.ts";
import { FRESH_BUILD_TIMEOUT_MS } from "../session/build-watch.ts";
import type { PartRequests } from "../session/part-requests.ts";
import type { SessionSync } from "../session/session-sync.ts";
import type { SessionStatus } from "../session/status.ts";
import { createStatusStore } from "../session/status.ts";
import type { StopRequest } from "../session/stop-source.ts";
import { controlHandlers, controlOwner } from "./control.ts";

function makeTarget() {
	const request = vi.fn<(stop: StopRequest) => void>();
	const status = createStatusStore(
		{
			compiler: false,
			open: false,
			owner: null,
			pid: 7,
			port: 1,
			rojo: true,
			sessionId: "s1",
			startedAt: "2026-01-01T00:00:00.000Z",
			syncback: false,
		},
		() => 0,
		vi.fn<(next: SessionStatus) => void>(),
	);
	const runAsync = vi.fn<SessionSync["runAsync"]>().mockResolvedValue({ input: "game.rbxl" });
	const addAsync = vi.fn<PartRequests["addAsync"]>().mockResolvedValue(["compiler"]);
	const stopAsync = vi.fn<PartRequests["stopAsync"]>().mockResolvedValue({
		ending: false,
		kept: [{ owner: "start", part: "studio" }],
		stopped: ["compiler"],
	});
	const ownAsync = vi.fn<PartRequests["ownAsync"]>().mockResolvedValue({
		added: ["studio"],
		taken: ["compiler"],
	});
	const releaseAsync = vi.fn<PartRequests["releaseAsync"]>().mockResolvedValue({
		ending: false,
		released: ["compiler"],
		sessionId: "s1",
		stopped: [],
		studioLeft: true,
	});
	const builds = {
		tick: vi.fn<BuildWatch["tick"]>(),
		waitAsync: vi.fn<BuildWatch["waitAsync"]>().mockResolvedValue(),
	};
	return {
		addAsync,
		builds,
		handlers: controlHandlers({
			builds,
			parts: { addAsync, ownAsync, releaseAsync, stopAsync },
			sessionId: "s1",
			status,
			stop: { request },
			sync: { runAsync },
		}),
		ownAsync,
		owner: controlOwner({
			parts: { addAsync, ownAsync, releaseAsync, stopAsync },
			sessionId: "s1",
		}),
		releaseAsync,
		request,
		runAsync,
		status,
		stopAsync,
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

	it("should answer addParts with the parts the session started", async () => {
		expect.assertions(2);

		const { addAsync, handlers } = makeTarget();

		await expect(
			handlers.addParts!({ parts: ["compiler", "studio"], studioPath: "/opt/Studio" }),
		).resolves.toStrictEqual({ added: ["compiler"] });
		expect(addAsync).toHaveBeenCalledExactlyOnceWith({
			parts: ["compiler", "studio"],
			studioPath: "/opt/Studio",
		});
	});

	it.for([
		[{}],
		[{ parts: "compiler" }],
		[{ parts: ["rojo"] }],
		[{ parts: [], studioPath: 1 }],
	] as const)("should refuse addParts params %j with usage", async ([parameters]) => {
		expect.assertions(3);

		const { addAsync, handlers } = makeTarget();
		const added = handlers.addParts!(parameters);

		await expect(added).rejects.toMatchObject({ code: "usage" });
		await expect(added).rejects.toThrow("addParts takes a list of parts: ");
		expect(addAsync).not.toHaveBeenCalled();
	});

	it("should answer stopParts with what the session stopped and kept", async () => {
		expect.assertions(2);

		const { handlers, stopAsync } = makeTarget();

		await expect(
			handlers.stopParts!({
				force: true,
				place: "/p/game.rbxl",
				recovery: "delete",
				scope: "stop",
				sessionId: "s1",
			}),
		).resolves.toStrictEqual({
			ending: false,
			kept: [{ owner: "start", part: "studio" }],
			stopped: ["compiler"],
		});
		expect(stopAsync).toHaveBeenCalledExactlyOnceWith({
			force: true,
			keepStudio: false,
			place: "/p/game.rbxl",
			recovery: "delete",
			scope: "stop",
		});
	});

	it("should refuse stopParts for another session's id", async () => {
		expect.assertions(2);

		const { handlers, stopAsync } = makeTarget();

		await expect(
			handlers.stopParts!({ scope: "down", sessionId: "old" }),
		).rejects.toMatchObject({
			code: "session_replaced",
		});
		expect(stopAsync).not.toHaveBeenCalled();
	});

	it.for([
		[{}],
		[{ scope: "idle" }],
		[{ force: "yes", scope: "down" }],
		[{ place: 1, scope: "stop" }],
	] as const)("should refuse stopParts params %j with usage", async ([parameters]) => {
		expect.assertions(3);

		const { handlers, stopAsync } = makeTarget();
		const stopped = handlers.stopParts!(parameters);

		await expect(stopped).rejects.toMatchObject({ code: "usage" });
		await expect(stopped).rejects.toThrow("stopParts takes a scope: ");
		expect(stopAsync).not.toHaveBeenCalled();
	});

	it("should answer sync with the session's syncback run", async () => {
		expect.assertions(2);

		const { handlers, runAsync } = makeTarget();

		await expect(handlers.sync!({})).resolves.toStrictEqual({ input: "game.rbxl" });
		expect(runAsync).toHaveBeenCalledOnce();
	});
});

describe(controlOwner, () => {
	it("should join with the parts asked for, and answer with the session's id", async () => {
		expect.assertions(2);

		const { ownAsync, owner } = makeTarget();

		await expect(
			owner.join({ parts: ["studio"], studioPath: "/opt/Studio" }),
		).resolves.toStrictEqual({ added: ["studio"], sessionId: "s1", taken: ["compiler"] });
		expect(ownAsync).toHaveBeenCalledExactlyOnceWith({
			parts: ["studio"],
			studioPath: "/opt/Studio",
		});
	});

	it("should refuse a join with no list of parts", async () => {
		expect.assertions(2);

		const { ownAsync, owner } = makeTarget();

		await expect(owner.join({ parts: "studio" })).rejects.toMatchObject({ code: "usage" });
		expect(ownAsync).not.toHaveBeenCalled();
	});

	it.for(["gone", "release"] as const)(
		"should let go of the parts as its owner is gone, on %s",
		async (how) => {
			expect.assertions(2);

			const { owner, releaseAsync } = makeTarget();

			await expect(owner.leave(how)).resolves.toStrictEqual({
				ending: false,
				released: ["compiler"],
				sessionId: "s1",
				stopped: [],
				studioLeft: true,
			});
			expect(releaseAsync).toHaveBeenCalledExactlyOnceWith({ type: "owner_gone" });
		},
	);
});
