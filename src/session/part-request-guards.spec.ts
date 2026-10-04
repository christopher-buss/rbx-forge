import { fromPartial } from "@total-typescript/shoehorn";

import { describe, expect, it } from "vitest";

import { createPartRequests } from "./part-requests.ts";

describe("guarded session stops", () => {
	it("explains when the running session has no Studio move handler", async () => {
		expect.assertions(1);

		const parts = createPartRequests();
		parts.attach(fromPartial({}));

		await expect(parts.moveAsync({ desktop: "user", timeoutMs: 1000 })).rejects.toMatchObject({
			code: "studio_not_open",
			message: "No session Studio is open.",
		});
	});

	it("keeps the session running when a queued stop is no longer needed", async () => {
		expect.assertions(1);

		const parts = createPartRequests();
		parts.attach(
			fromPartial({
				stop: async () => {
					throw new Error("The session became active again.");
				},
			}),
		);

		await expect(
			parts.stopAsync({ force: false, keepStudio: false, scope: "down" }, () => false),
		).resolves.toStrictEqual({
			ending: false,
			kept: [],
			stopped: [],
		});
	});

	it("stops once the request reaches the queue and its guard still allows it", async () => {
		expect.assertions(1);

		const parts = createPartRequests();
		parts.attach(
			fromPartial({
				stop: async () => {
					return { ending: true, kept: [], stopped: ["studio"] };
				},
			}),
		);

		await expect(
			parts.stopAsync({ force: false, keepStudio: false, scope: "down" }, () => true),
		).resolves.toStrictEqual({
			ending: true,
			kept: [],
			stopped: ["studio"],
		});
	});
});
