import path from "node:path";
import { describe, expect, it } from "vitest";

import { PROJECT } from "../../test/helpers/seams.ts";
import { forgeFiles } from "../supervisor/session-files.ts";
import { recoveryOptions, sessionStudioTarget } from "./studio.ts";

const PLACE = path.join(PROJECT, "game.rbxl");

describe(sessionStudioTarget, () => {
	it("should target the Studio forge started, open or opening", () => {
		expect.assertions(2);

		expect(
			sessionStudioTarget({
				owner: null,
				pid: 7,
				place: PLACE,
				startTime: "70",
				status: "open",
			}),
		).toStrictEqual({ place: PLACE, process: { pid: 7, startTime: "70" } });
		expect(sessionStudioTarget({ owner: null, place: PLACE, status: "opening" })).toStrictEqual(
			{
				place: PLACE,
			},
		);
	});

	it("should target nothing for a closed or unknown place", () => {
		expect.assertions(3);

		expect(
			sessionStudioTarget({ owner: null, place: PLACE, status: "closed" }),
		).toBeUndefined();
		expect(sessionStudioTarget({ owner: null, place: PLACE, status: "off" })).toBeUndefined();
		expect(sessionStudioTarget({ owner: null, status: "opening" })).toBeUndefined();
	});

	it("should need both the PID and the start time to pin", () => {
		expect.assertions(1);

		expect(
			sessionStudioTarget({ owner: null, pid: 7, place: PLACE, status: "open" }),
		).toStrictEqual({
			place: PLACE,
		});
	});
});

describe(recoveryOptions, () => {
	it("should move files to .forge/recovery, in the mode the config sets", () => {
		expect.assertions(1);

		expect(
			recoveryOptions({ HOME: "/home" }, forgeFiles(PROJECT), {
				studio: { autoRecovery: "delete" },
			}),
		).toStrictEqual({
			env: { HOME: "/home" },
			mode: "delete",
			recoveryDirectory: path.join(PROJECT, ".forge", "recovery"),
		});
	});
});
