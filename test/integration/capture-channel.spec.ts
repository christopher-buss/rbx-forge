import { fromAny } from "@total-typescript/shoehorn";

import { Buffer } from "node:buffer";
import { describe, it } from "vitest";

import { nodeNetwork } from "../../src/seams/network.ts";

describe("capture channel", () => {
	it("accepts one binary capture only from the current request and identity", async ({
		expect,
		onTestFinished,
	}) => {
		expect.assertions(5);

		const listener = await nodeNetwork.listenForCaptureAsync({
			projectName: "project",
			sessionId: "session",
		});
		onTestFinished(listener.close);
		const signal = AbortSignal.timeout(5000);
		const capturing = listener.captureAsync(signal);
		const poll = await fetch(listener.url, { signal });
		const request = fromAny<{ requestId: string }, unknown>(await poll.json());

		expect(request).toMatchObject({
			projectName: "project",
			sessionId: "session",
		});
		expect(request.requestId).toBeTypeOf("string");

		const metadata = Buffer.from(
			JSON.stringify({ services: [{ name: "Workspace", roots: [0] }] }),
		);
		const frame = Buffer.alloc(4 + metadata.length + 4);
		frame.writeUInt32LE(metadata.length);
		metadata.copy(frame, 4);
		frame.set([0, 128, 255, 10], 4 + metadata.length);
		const wrong = await fetch(listener.url.replace("sessionId=session", "sessionId=other"), {
			body: frame,
			method: "POST",
			signal,
		});

		expect(wrong.status).toBe(404);

		const posted = await fetch(`${listener.url}&requestId=${request.requestId}`, {
			body: frame,
			method: "POST",
			signal,
		});

		expect(posted.status).toBe(204);
		await expect(capturing).resolves.toEqual({
			model: new Uint8Array([0, 128, 255, 10]),
			services: [{ name: "Workspace", roots: [0] }],
		});
	});
});
