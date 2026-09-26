import path from "node:path";
import { describe, expect, it } from "vitest";

import { PROJECT } from "../../test/helpers/seams.ts";
import { parseStopRequest, parseStopResult } from "./part-stop-schema.ts";
import type { PartStops, StopPartsRequest } from "./part-stops.ts";

const PLACE = path.join(PROJECT, "game.rbxl");
const DOWN: StopPartsRequest = { force: false, keepStudio: false, scope: "down" };

describe(parseStopRequest, () => {
	it("should default force and keepStudio to false, and keep only what it reads", () => {
		expect.assertions(2);

		expect(parseStopRequest({ scope: "down", sessionId: "s1" })).toStrictEqual(DOWN);
		expect(
			parseStopRequest({
				force: true,
				keepStudio: true,
				place: PLACE,
				recovery: "move",
				scope: "restart",
			}),
		).toStrictEqual({
			force: true,
			keepStudio: true,
			place: PLACE,
			recovery: "move",
			scope: "restart",
		});
	});
});

describe(parseStopResult, () => {
	it("should read what a session stopped, with how its Studio went", () => {
		expect.assertions(3);

		const closed: PartStops = {
			ending: true,
			kept: [],
			stopped: ["studio"],
			studio: {
				place: PLACE,
				stop: {
					end: "dialog",
					forced: true,
					pid: 7,
					recovery: {
						deleted: [],
						mode: "move",
						moved: [{ from: "a", to: "b" }],
						warnings: [],
					},
					status: "stopped",
				},
			},
		};
		const failed: PartStops = {
			ending: false,
			kept: [{ owner: "start", part: "compiler" }],
			stopped: [],
			studio: { error: { code: "identity_mismatch", message: "no" }, place: PLACE },
		};

		expect(parseStopResult(closed)).toStrictEqual(closed);
		expect(parseStopResult(failed)).toStrictEqual(failed);
		expect(
			parseStopResult({ ending: true, kept: [], stopped: [], studio: { place: PLACE } }),
		).toBeUndefined();
	});
});
