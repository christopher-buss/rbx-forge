/**
 * The Windows Studio launch command line against the real `cmd.exe`. The
 * e2e tests cannot open a place whose path holds a `%`: their Studio
 * stand-in is a batch file, and Windows runs it through a second `cmd.exe`
 * that expands the path again. Real Studio gets the path unchanged. So this
 * test runs forge's command line with `echo` in place of `start`.
 */
import { spawnSync } from "node:child_process";
import process from "node:process";
import { describe, expect, it } from "vitest";

import { studioLaunchInvocation } from "../../src/studio/launcher.ts";

describe.skipIf(process.platform !== "win32")("studio launch command line", () => {
	it("should hand start a place whose path holds %TEMP% unchanged", () => {
		expect.assertions(1);

		const place = String.raw`C:\Users\me\My %TEMP% Places\100% & more\game.rbxl`;
		const { args, env, file } = studioLaunchInvocation(place, "win32", process.env);
		const echoed = args.map((argument) => argument.replace('start ""', "echo"));
		const { stdout } = spawnSync(file, echoed, {
			encoding: "utf8",
			env,
			windowsHide: true,
			windowsVerbatimArguments: true,
		});

		expect(stdout.trim()).toBe(`"${place}"`);
	});
});
