import { describe, expect, it, vi } from "vitest";

import { ForgeError } from "../errors.ts";
import type { PartAdder } from "./part-requests.ts";
import { createPartRequests, parseAddableParts } from "./part-requests.ts";

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
		const added = requests.addAsync(["compiler"]);
		await flushAsync();
		const calledEarly = add.mock.calls.length;
		requests.attach(add);

		await expect(added).resolves.toStrictEqual(["compiler"]);
		expect(calledEarly).toBe(0);
		expect(add).toHaveBeenCalledExactlyOnceWith(["compiler"]);
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
		const one = requests.addAsync(["compiler"]);
		const two = requests.addAsync(["compiler"]);
		const three = requests.addAsync([]);
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
		const waiting = requests.addAsync(["compiler"]);
		requests.close();
		requests.attach(vi.fn<PartAdder>());

		await expect(waiting).rejects.toMatchObject({
			code: "not_running",
			hint: 'Start a session with "forge up".',
			message: "The session is stopping; it adds no parts.",
		});
		await expect(requests.addAsync(["compiler"])).rejects.toMatchObject({
			code: "not_running",
		});
	});

	it("should fail with not_running once closed after the adder came", async () => {
		expect.assertions(1);

		const requests = createPartRequests();
		const add = vi.fn<PartAdder>();
		requests.attach(add);
		requests.close();

		await expect(requests.addAsync(["compiler"])).rejects.toMatchObject({
			code: "not_running",
		});
	});
});

describe(parseAddableParts, () => {
	it("should read a list of parts", () => {
		expect.assertions(2);

		expect(parseAddableParts(["compiler"])).toStrictEqual(["compiler"]);
		expect(parseAddableParts([])).toStrictEqual([]);
	});
});
