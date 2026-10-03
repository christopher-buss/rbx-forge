import { describe, expect, it, onTestFinished } from "vitest";

import { nodeNetwork } from "../../src/seams/network.ts";

describe("studio sync acknowledgement", () => {
	it("should accept only the launch token and expected Rojo identity, then close", async () => {
		expect.assertions(5);

		const listener = await nodeNetwork.listenForStudioReadyAsync({
			projectName: "Game@worktree",
			sessionId: "session-1",
		});
		onTestFinished(listener.close);
		const wrong = new URL(listener.url);
		wrong.searchParams.set("sessionId", "foreign");

		await expect(fetch(wrong)).resolves.toMatchObject({ status: 404 });
		await expect(fetch(listener.url, { method: "POST" })).resolves.toMatchObject({
			status: 404,
		});
		await expect(fetch(listener.url)).resolves.toMatchObject({ status: 204 });
		await expect(listener.ready).resolves.toBeTrue();

		listener.close();

		await expect(fetch(listener.url)).rejects.toThrow("fetch failed");
	});
});
