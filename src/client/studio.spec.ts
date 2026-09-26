import path from "node:path";
import { describe, expect, it } from "vitest";

import { PROJECT } from "../../test/helpers/seams.ts";
import { forgeFiles } from "../supervisor/session-files.ts";
import { recoveryOptions } from "./studio.ts";

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
