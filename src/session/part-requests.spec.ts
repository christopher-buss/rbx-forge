import { describe, expect, it, vi } from "vitest";

import { ForgeError } from "../errors.ts";
import type { PartAdder, PartRequest } from "./part-requests.ts";
import { createPartRequests, parsePartRequest } from "./part-requests.ts";

const COMPILER = { parts: ["compiler"] } satisfies PartRequest;

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
		requests.attach(add);

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
		requests.attach(add);
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
		requests.attach(vi.fn<PartAdder>());

		await expect(waiting).rejects.toMatchObject({
			code: "not_running",
			hint: 'Start a session with "forge up".',
			message: "The session is stopping; it adds no parts.",
		});
		await expect(requests.addAsync(COMPILER)).rejects.toMatchObject({
			code: "not_running",
		});
	});

	it("should fail with not_running once closed after the adder came", async () => {
		expect.assertions(1);

		const requests = createPartRequests();
		const add = vi.fn<PartAdder>();
		requests.attach(add);
		requests.close();

		await expect(requests.addAsync(COMPILER)).rejects.toMatchObject({
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
