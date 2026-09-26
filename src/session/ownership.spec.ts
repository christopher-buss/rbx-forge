import { describe, expect, it, vi } from "vitest";

import { makeStatus } from "../../test/helpers/fake-session.ts";
import type { OwnerRelease, ReleasePlan } from "./ownership.ts";
import { createOwnerHandlers, planRelease, releasedResult } from "./ownership.ts";
import type { PartAdder } from "./part-requests.ts";
import type { SessionScope } from "./run-session.ts";
import type { ServiceParts } from "./service-parts.ts";
import type { PartId, ServicePart, SessionStatus, SessionStudio } from "./status.ts";
import { createStatusStore } from "./status.ts";

type Services = SessionStatus["services"];

const S1 = { sessionId: "s1" } satisfies Pick<OwnerRelease, "sessionId">;

const OWNED_READY: Partial<ServicePart> = { owner: "start", status: "ready" };
const READY: Partial<ServicePart> = { owner: null, status: "ready" };
const OWNED_OPEN: Partial<SessionStudio> = {
	owner: "start",
	place: "/p/game.rbxl",
	status: "open",
};

function servicesWith(
	parts: {
		compiler?: Partial<Services["compiler"]>;
		rojo?: Partial<Services["rojo"]>;
		studio?: Partial<SessionStudio>;
	} = {},
): Services {
	const { services } = makeStatus();
	return {
		...services,
		compiler: { ...services.compiler, ...parts.compiler },
		rojo: { ...services.rojo, status: "off", ...parts.rojo },
		studio: { ...services.studio, ...parts.studio },
	};
}

describe(planRelease, () => {
	it.for<[string, Services, Array<PartId>, ReleasePlan]>([
		[
			"stops what it started and ends with nothing else",
			servicesWith({ compiler: OWNED_READY, rojo: OWNED_READY, studio: OWNED_OPEN }),
			["studio", "rojo", "compiler"],
			{
				clear: ["studio", "rojo", "compiler"],
				isKept: false,
				release: [],
				stop: ["studio", "rojo", "compiler"],
			},
		],
		[
			"gives back what it took, which runs on",
			servicesWith({ compiler: OWNED_READY, rojo: OWNED_READY, studio: OWNED_OPEN }),
			["studio", "rojo"],
			{
				clear: ["studio", "rojo", "compiler"],
				isKept: true,
				release: ["compiler"],
				stop: ["studio", "rojo"],
			},
		],
		[
			"runs on with a part that has no owner",
			servicesWith({ compiler: READY, rojo: OWNED_READY }),
			["rojo"],
			{ clear: ["rojo"], isKept: true, release: [], stop: ["rojo"] },
		],
		[
			"clears the owner of a failed part, and neither stops nor gives it back",
			servicesWith({ compiler: { owner: "start", status: "failed" }, rojo: READY }),
			[],
			{ clear: ["compiler"], isKept: true, release: [], stop: [] },
		],
		[
			"ends a session with no part",
			servicesWith(),
			[],
			{ clear: [], isKept: false, release: [], stop: [] },
		],
	])("should plan an owner's end that %s", ([, services, added, plan]) => {
		expect.assertions(1);

		expect(planRelease(services, new Set(added))).toStrictEqual(plan);
	});
});

describe(releasedResult, () => {
	it.for<[OwnerRelease, string]>([
		[
			{ ...S1, ending: false, released: ["compiler"], stopped: ["rojo"], studioLeft: true },
			"Let go of session s1: stopped Rojo; left Studio open; the compiler runs on with no owner.",
		],
		[
			{ ...S1, ending: false, released: ["studio", "rojo"], stopped: [], studioLeft: false },
			"Let go of session s1: Studio and Rojo run on with no owner.",
		],
		[
			{ ...S1, ending: true, released: [], stopped: ["rojo", "compiler"], studioLeft: false },
			"Let go of session s1: stopped Rojo and the compiler. No part is left, so the session ends.",
		],
		[
			{ ...S1, ending: false, released: [], stopped: [], studioLeft: false },
			"Let go of session s1: it owned no part.",
		],
	])("should say what the end did: %s", ([release, summary]) => {
		expect.assertions(1);

		expect(releasedResult(release)).toStrictEqual({ data: release, summary });
	});
});

function makeHandlers(add: PartAdder = async () => []) {
	const status = createStatusStore(
		{
			compiler: true,
			open: false,
			owner: null,
			pid: 1,
			port: 1,
			sessionId: "s1",
			startedAt: "t",
			syncback: false,
		},
		() => 0,
		() => {},
	);
	status.started();
	status.service("compiler", "ready");
	const end = vi.fn<SessionScope["end"]>();
	const stopAsync = vi.fn<ServiceParts["stopAsync"]>().mockResolvedValue();
	const ownership = { added: new Set<PartId>(), isOwned: false };
	const handlers = createOwnerHandlers(
		{ status },
		{ end },
		{ add, ownership, parts: { stopAsync }, studio: { isAttached: false } },
	);
	return { end, handlers, ownership, status, stopAsync };
}

describe(createOwnerHandlers, () => {
	it("should let go of nothing while no owner holds the session", async () => {
		expect.assertions(2);

		const { end, handlers, status } = makeHandlers();
		status.service("compiler", "off");

		await expect(handlers.release({ type: "owner_gone" })).resolves.toStrictEqual({
			ending: false,
			released: [],
			sessionId: "s1",
			stopped: [],
			studioLeft: false,
		});
		expect(end).not.toHaveBeenCalled();
	});

	it("should end the session with the owner's reason once it leaves no part", async () => {
		expect.assertions(3);

		const { end, handlers, status } = makeHandlers();
		status.service("compiler", "off");
		await handlers.own({ parts: [] });

		await expect(handlers.release({ signal: "SIGINT", type: "signal" })).resolves.toStrictEqual(
			{ ...S1, ending: true, released: [], stopped: [], studioLeft: false },
		);
		expect(end).toHaveBeenCalledExactlyOnceWith({ signal: "SIGINT", type: "signal" });
		expect(status.snapshot().phase).toBe("stopping");
	});

	it("should give back what it took when the add fails, and throw the failure", async () => {
		expect.assertions(3);

		const { handlers, ownership, status } = makeHandlers(async () => {
			throw new Error("add failed");
		});

		await expect(handlers.own({ parts: ["studio"] })).rejects.toThrow("add failed");
		expect(status.snapshot().services.compiler.owner).toBeNull();
		expect(ownership.isOwned).toBeFalse();
	});

	it("should give back a Studio it took, open, and forget what an earlier owner added", async () => {
		expect.assertions(3);

		const add = vi.fn<PartAdder>().mockResolvedValueOnce(["compiler"]).mockResolvedValue([]);
		const { handlers, status, stopAsync } = makeHandlers(add);
		status.studio("open", "/p/game.rbxl", null);
		await handlers.own({ parts: ["compiler"] });
		// `up` started the compiler again: it has no owner now.
		status.owner("compiler", null);
		await handlers.release({ type: "owner_gone" });
		await handlers.own({ parts: [] });
		const second = await handlers.release({ type: "owner_gone" });

		expect(second).toMatchObject({ released: ["studio", "compiler"], stopped: [] });
		expect(status.snapshot().services.studio).toMatchObject({ owner: null, status: "open" });
		expect(stopAsync).not.toHaveBeenCalled();
	});
});
