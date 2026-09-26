import { describe, expect, it, vi } from "vitest";

import { ForgeError } from "../errors.ts";
import type { OwnerHandlers } from "./ownership.ts";
import type { PartAdder, PartRequest } from "./part-requests.ts";
import { createPartRequests, parsePartRequest } from "./part-requests.ts";
import type { PartStopper, StopPartsRequest } from "./part-stops.ts";

const COMPILER = { parts: ["compiler"] } satisfies PartRequest;
const DOWN: StopPartsRequest = { force: false, keepStudio: false, scope: "down" };
const noStop = vi.fn<PartStopper>();
const NO_OWNER: OwnerHandlers = {
	own: vi.fn<OwnerHandlers["own"]>(),
	release: vi.fn<OwnerHandlers["release"]>(),
};
const RELEASED = {
	ending: false,
	released: [],
	sessionId: "s1",
	stopped: [],
	studioLeft: false,
};

async function flushAsync(): Promise<void> {
	await new Promise((resolve) => {
		setImmediate(resolve);
	});
}

describe(createPartRequests, () => {
	it("should wait for the body's adder, then add through it", async () => {
		expect.assertions(3);

		const requests = createPartRequests();
		const add = vi.fn<PartAdder>().mockResolvedValue(["compiler"]);
		const added = requests.addAsync(COMPILER);
		await flushAsync();
		const calledEarly = add.mock.calls.length;
		requests.attach({ add, stop: noStop, ...NO_OWNER });

		await expect(added).resolves.toStrictEqual(["compiler"]);
		expect(calledEarly).toBe(0);
		expect(add).toHaveBeenCalledExactlyOnceWith(COMPILER);
	});

	it("should run one request at a time, also after a failed one", async () => {
		expect.assertions(3);

		const requests = createPartRequests();
		const first = Promise.withResolvers<Array<"compiler">>();
		const add = vi
			.fn<PartAdder>()
			.mockReturnValueOnce(first.promise)
			.mockRejectedValueOnce(new ForgeError("compiler_missing", "gone"))
			.mockResolvedValue([]);
		requests.attach({ add, stop: noStop, ...NO_OWNER });
		const one = requests.addAsync(COMPILER);
		const two = requests.addAsync(COMPILER);
		const three = requests.addAsync({ parts: [] });
		await flushAsync();
		const callsWhileFirstRuns = add.mock.calls.length;
		first.resolve(["compiler"]);

		expect(callsWhileFirstRuns).toBe(1);
		await expect(Promise.allSettled([one, two, three])).resolves.toMatchObject([
			{ status: "fulfilled", value: ["compiler"] },
			{ reason: { code: "compiler_missing" }, status: "rejected" },
			{ status: "fulfilled", value: [] },
		]);
		expect(add).toHaveBeenCalledTimes(3);
	});

	it("should fail a waiting request and a late one with not_running once closed", async () => {
		expect.assertions(2);

		const requests = createPartRequests();
		const waiting = requests.addAsync(COMPILER);
		requests.close();
		requests.attach({ add: vi.fn<PartAdder>(), stop: noStop, ...NO_OWNER });

		await expect(waiting).rejects.toMatchObject({
			code: "not_running",
			hint: 'Start a session with "forge up".',
			message: "The session is stopping; it adds and stops no parts.",
		});
		await expect(requests.addAsync(COMPILER)).rejects.toMatchObject({
			code: "not_running",
		});
	});

	it("should fail with not_running once closed after the adder came", async () => {
		expect.assertions(1);

		const requests = createPartRequests();
		const add = vi.fn<PartAdder>();
		requests.attach({ add, stop: noStop, ...NO_OWNER });
		requests.close();

		await expect(requests.addAsync(COMPILER)).rejects.toMatchObject({
			code: "not_running",
		});
	});
});

describe("createPartRequests stops", () => {
	it("should fail a stop at once while the session starts", async () => {
		expect.assertions(1);

		const requests = createPartRequests();

		await expect(requests.stopAsync(DOWN)).rejects.toMatchObject({
			code: "not_running",
			hint: "Stop the whole session.",
			message: "The session is starting; it stops no part yet.",
		});
	});

	it("should stop through the body's stopper, after the add that runs", async () => {
		expect.assertions(2);

		const requests = createPartRequests();
		const adding = Promise.withResolvers<Array<"compiler">>();
		const order: Array<string> = [];
		const add = vi.fn<PartAdder>(async () => {
			const added = await adding.promise;
			order.push("add");
			return added;
		});
		const stop = vi.fn<PartStopper>(async () => {
			order.push("stop");
			return { ending: true, kept: [], stopped: ["compiler"] };
		});
		requests.attach({ add, stop, ...NO_OWNER });
		const added = requests.addAsync(COMPILER);
		const stopped = requests.stopAsync(DOWN);
		await flushAsync();
		adding.resolve(["compiler"]);

		await expect(Promise.all([added, stopped])).resolves.toStrictEqual([
			["compiler"],
			{ ending: true, kept: [], stopped: ["compiler"] },
		]);
		expect(order).toStrictEqual(["add", "stop"]);
	});

	it("should fail a stop with not_running once closed", async () => {
		expect.assertions(1);

		const requests = createPartRequests();
		requests.attach({ add: vi.fn<PartAdder>(), stop: noStop, ...NO_OWNER });
		requests.close();

		await expect(requests.stopAsync(DOWN)).rejects.toMatchObject({
			code: "not_running",
			message: "The session is stopping; it adds and stops no parts.",
		});
	});
});

describe("createPartRequests owners", () => {
	it("should wait for the body's handlers to join, and release only once they came", async () => {
		expect.assertions(4);

		const requests = createPartRequests();
		const own = vi.fn<OwnerHandlers["own"]>().mockResolvedValue({ added: [], taken: [] });
		const release = vi.fn<OwnerHandlers["release"]>().mockResolvedValue(RELEASED);
		const joined = requests.ownAsync(COMPILER);
		const early = requests.releaseAsync({ type: "owner_gone" }).catch((err: unknown) => err);
		await flushAsync();
		const calledEarly = own.mock.calls.length;
		requests.attach({ add: vi.fn<PartAdder>(), own, release, stop: noStop });

		await expect(early).resolves.toMatchObject({ code: "not_running" });
		await expect(joined).resolves.toStrictEqual({ added: [], taken: [] });
		await expect(requests.releaseAsync({ type: "owner_gone" })).resolves.toStrictEqual(
			RELEASED,
		);
		expect([calledEarly, own.mock.calls, release.mock.calls]).toStrictEqual([
			0,
			[[COMPILER]],
			[[{ type: "owner_gone" }]],
		]);
	});

	it("should fail a join and a release with not_running once closed", async () => {
		expect.assertions(2);

		const requests = createPartRequests();
		requests.attach({ add: vi.fn<PartAdder>(), stop: noStop, ...NO_OWNER });
		requests.close();

		await expect(requests.ownAsync(COMPILER)).rejects.toMatchObject({ code: "not_running" });
		await expect(requests.releaseAsync({ type: "owner_gone" })).rejects.toMatchObject({
			code: "not_running",
		});
	});
});

describe(parsePartRequest, () => {
	it("should read a list of parts, and a Studio path", () => {
		expect.assertions(2);

		expect(parsePartRequest({ parts: ["compiler", "studio"] })).toStrictEqual({
			parts: ["compiler", "studio"],
		});
		expect(parsePartRequest({ parts: [], studioPath: "/opt/Studio" })).toStrictEqual({
			parts: [],
			studioPath: "/opt/Studio",
		});
	});
});
