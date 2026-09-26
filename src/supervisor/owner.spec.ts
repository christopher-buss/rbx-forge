import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { createStopSource } from "../session/stop-source.ts";
import { encodeStop } from "./channel.ts";
import { watchOwner } from "./owner.ts";

function watched() {
	const input = new PassThrough();
	const stop = createStopSource();
	watchOwner(input, stop);
	return { input, stop };
}

async function flushAsync(): Promise<void> {
	await new Promise((resolve) => {
		setImmediate(resolve);
	});
}

describe(watchOwner, () => {
	it("should pass on a stop line's signal and ignore other lines", async () => {
		expect.assertions(2);

		const { input, stop } = watched();
		input.write("noise\n");
		await flushAsync();

		expect(stop.reason()).toBeUndefined();

		input.write(encodeStop("SIGINT"));
		await flushAsync();

		expect(stop.reason()).toStrictEqual({ signal: "SIGINT", type: "signal" });
	});

	it("should stop with owner_gone at EOF", async () => {
		expect.assertions(1);

		const { input, stop } = watched();
		input.end();
		await flushAsync();

		expect(stop.reason()).toStrictEqual({ type: "owner_gone" });
	});

	it("should stop with owner_gone when the pipe fails", async () => {
		expect.assertions(1);

		const { input, stop } = watched();
		input.emit("error", new Error("EPIPE"));
		await flushAsync();

		expect(stop.reason()).toStrictEqual({ type: "owner_gone" });
	});
});
