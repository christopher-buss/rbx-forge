import { describe, it } from "vitest";

import { ForgeError } from "../errors.ts";
import { handshakeWindowsHelperAsync, windowsHelperLaunchError } from "./windows-helper.ts";

const IDENTITY = { helperArch: "x64", hostname: "windows-host", protocol: 1, windowsArch: "x64" };

describe(handshakeWindowsHelperAsync, () => {
	it("should accept the matching Windows identity", async ({ expect }) => {
		expect.assertions(1);
		await expect(handshakeWindowsHelperAsync("x64", async () => IDENTITY)).resolves.toEqual(
			IDENTITY,
		);
	});

	it("should accept a native arm64 Windows identity", async ({ expect }) => {
		expect.assertions(1);

		const identity = { ...IDENTITY, helperArch: "arm64", windowsArch: "arm64" };

		await expect(handshakeWindowsHelperAsync("arm64", async () => identity)).resolves.toEqual(
			identity,
		);
	});

	it.for([
		{ protocol: 2 },
		{ helperArch: "arm64" },
		{ windowsArch: "arm64" },
		{ hostname: "" },
		{ hostname: 5 },
	])("should reject an incompatible helper %o", async (override, { expect }) => {
		expect.assertions(1);
		await expect(
			handshakeWindowsHelperAsync("x64", async () => {
				return { ...IDENTITY, ...override };
			}),
		).rejects.toMatchObject({
			code: "windows_helper_unavailable",
			exitCode: 1,
			hint: "Reinstall rbx-forge with optional dependencies and the Windows helper matching your Linux architecture.",
		});
	});

	it("should preserve a missing helper diagnosis from startup", async ({ expect }) => {
		expect.assertions(1);

		const missing = new ForgeError("windows_helper_unavailable", "missing executable");

		await expect(
			handshakeWindowsHelperAsync("x64", async () => {
				throw missing;
			}),
		).rejects.toBe(missing);
	});

	it("should explain a broken interop channel", async ({ expect }) => {
		expect.assertions(1);
		await expect(
			handshakeWindowsHelperAsync("x64", async () => {
				throw new Error("EOF");
			}),
		).rejects.toMatchObject({
			code: "wsl_interop_unavailable",
			exitCode: 1,
			hint: "Enable [interop] enabled=true in /etc/wsl.conf, restart WSL with `wsl --shutdown` from Windows, and check that Windows executables run from this distro.",
		});
	});
});

describe(windowsHelperLaunchError, () => {
	it.for(["ENOENT", "EACCES", "EPERM"])(
		"should explain a helper that cannot run (%s)",
		(code, { expect }) => {
			expect.assertions(1);
			expect(
				windowsHelperLaunchError(Object.assign(new Error("cannot launch"), { code })),
			).toMatchObject({
				code: "windows_helper_unavailable",
				exitCode: 1,
				hint: "Reinstall rbx-forge with optional dependencies and the Windows helper matching your Linux architecture.",
			});
		},
	);

	it("should diagnose interop from an actual exec format failure", ({ expect }) => {
		expect.assertions(1);
		expect(windowsHelperLaunchError({ code: "ENOEXEC" })).toMatchObject({
			code: "wsl_interop_unavailable",
			exitCode: 1,
			hint: "Enable [interop] enabled=true in /etc/wsl.conf, restart WSL with `wsl --shutdown` from Windows, and check that Windows executables run from this distro.",
		});
	});
});
