import { describe, expect, it } from "vitest";

import type { EndpointInput } from "./endpoint.ts";
import { endpointFor, endpointKey, MAX_SOCKET_PATH } from "./endpoint.ts";

const POSIX: EndpointInput = {
	buildOutputPath: "game.rbxl",
	env: {},
	platform: "linux",
	projectRoot: "/home/me/game",
	userId: 1000,
};
// The first 16 hex characters of sha256 of "/home/me/game", NUL, "game.rbxl".
const KEY = "ca97b6e21788943f";

describe(endpointKey, () => {
	it("should hash the root and the build output, apart", () => {
		expect.assertions(3);

		expect(endpointKey("/home/me/game", "game.rbxl")).toBe(KEY);
		expect(endpointKey("/home/me/game", "other.rbxl")).not.toBe(KEY);
		// The separator keeps "a" + "bc" apart from "ab" + "c".
		expect(endpointKey("a", "bc")).not.toBe(endpointKey("ab", "c"));
	});
});

describe(endpointFor, () => {
	it("should name a pipe on Windows", () => {
		expect.assertions(1);

		expect(endpointFor({ ...POSIX, platform: "win32", userId: undefined })).toBe(
			`\\\\.\\pipe\\rbx-forge-${KEY}`,
		);
	});

	it("should put the socket in a per-user directory of the runtime directory", () => {
		expect.assertions(3);

		expect(
			endpointFor({ ...POSIX, env: { TMPDIR: "/t", XDG_RUNTIME_DIR: "/run/user/1000" } }),
		).toBe(`/run/user/1000/rbx-forge-1000-${KEY}/ctl.sock`);
		expect(endpointFor({ ...POSIX, env: { TMPDIR: "/var/folders/x/T/" } })).toBe(
			`/var/folders/x/T/rbx-forge-1000-${KEY}/ctl.sock`,
		);
		expect(endpointFor(POSIX)).toBe(`/tmp/rbx-forge-1000-${KEY}/ctl.sock`);
	});

	it("should fall back to /tmp when the socket path would be too long", () => {
		expect.assertions(2);

		// `<runtime>/rbx-forge-1000-<key>/ctl.sock` adds 41 bytes.
		const longest = `/${"r".repeat(MAX_SOCKET_PATH - 42)}`;

		expect(endpointFor({ ...POSIX, env: { TMPDIR: longest } })).toBe(
			`${longest}/rbx-forge-1000-${KEY}/ctl.sock`,
		);
		expect(endpointFor({ ...POSIX, env: { TMPDIR: `${longest}r` } })).toBe(
			`/tmp/rbx-forge-1000-${KEY}/ctl.sock`,
		);
	});
});
