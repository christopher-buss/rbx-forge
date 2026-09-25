import { fromPartial } from "@total-typescript/shoehorn";

import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import packageJson from "../../package.json" with { type: "json" };
import { catchForgeError } from "../../test/helpers/errors.ts";
import { createFakeNative } from "../../test/helpers/native.ts";
import type { NativeHost, ReaperLocateOptions } from "./load.ts";
import { createNativeLoader, createReaperLocator, nativeTarget, readHost } from "./load.ts";

const WINDOWS: NativeHost = { arch: "x64", libc: undefined, platform: "win32" };
const LINUX: NativeHost = { arch: "x64", libc: "gnu", platform: "linux" };

/** Rust target triple (`package.json#napi.targets`) to Node host. */
const HOSTS_BY_TRIPLE: Record<string, NativeHost> = {
	"aarch64-apple-darwin": { arch: "arm64", libc: undefined, platform: "darwin" },
	"aarch64-pc-windows-msvc": { arch: "arm64", libc: undefined, platform: "win32" },
	"aarch64-unknown-linux-gnu": { arch: "arm64", libc: "gnu", platform: "linux" },
	"aarch64-unknown-linux-musl": { arch: "arm64", libc: "musl", platform: "linux" },
	"x86_64-apple-darwin": { arch: "x64", libc: undefined, platform: "darwin" },
	"x86_64-pc-windows-msvc": WINDOWS,
	"x86_64-unknown-linux-gnu": { arch: "x64", libc: "gnu", platform: "linux" },
	"x86_64-unknown-linux-musl": { arch: "x64", libc: "musl", platform: "linux" },
};

function makeLoader(
	options: {
		directory?: string;
		host?: NativeHost;
		requireModule?: (id: string) => unknown;
	} = {},
): ReturnType<typeof createNativeLoader> {
	return createNativeLoader({
		directory: options.directory,
		readHost: () => options.host ?? WINDOWS,
		requireModule: options.requireModule ?? (() => createFakeNative().addon),
	});
}

describe(nativeTarget, () => {
	it.for([
		[{ arch: "x64", libc: undefined, platform: "win32" }, "win32-x64-msvc"],
		[{ arch: "arm64", libc: undefined, platform: "win32" }, "win32-arm64-msvc"],
		[{ arch: "x64", libc: undefined, platform: "darwin" }, "darwin-x64"],
		[{ arch: "arm64", libc: undefined, platform: "darwin" }, "darwin-arm64"],
		[{ arch: "x64", libc: "gnu", platform: "linux" }, "linux-x64-gnu"],
		[{ arch: "arm64", libc: "gnu", platform: "linux" }, "linux-arm64-gnu"],
		[{ arch: "x64", libc: "musl", platform: "linux" }, "linux-x64-musl"],
		[{ arch: "arm64", libc: "musl", platform: "linux" }, "linux-arm64-musl"],
	] as const)("should name the build for %o as %s", ([host, target]) => {
		expect.assertions(1);

		expect(nativeTarget(host)).toBe(target);
	});

	it.for([
		{ arch: "ia32", libc: undefined, platform: "win32" },
		{ arch: "x64", libc: undefined, platform: "freebsd" },
		{ arch: "x64", libc: undefined, platform: "linux" },
		{ arch: "x64", libc: "gnu", platform: "darwin" },
	] as const)("should have no build for %o", (host) => {
		expect.assertions(1);

		expect(nativeTarget(host)).toBeUndefined();
	});

	it("should have a build for every target the crate is built for", () => {
		expect.assertions(1);

		const targets = packageJson.napi.targets.map((triple) => {
			return nativeTarget(HOSTS_BY_TRIPLE[triple]!);
		});

		expect(targets).not.toContain(undefined);
	});
});

describe(readHost, () => {
	it("should read the C library from the process report on Linux", () => {
		expect.assertions(1);

		const report = { getReport: () => ({ header: { glibcVersionRuntime: "2.39" } }) };

		expect(readHost(fromPartial({ arch: "x64", platform: "linux", report }))).toStrictEqual({
			arch: "x64",
			libc: "gnu",
			platform: "linux",
		});
	});

	it("should take a Linux report without a glibc version as musl", () => {
		expect.assertions(1);

		const report = { getReport: () => ({ header: {} }) };

		expect(readHost(fromPartial({ arch: "arm64", platform: "linux", report })).libc).toBe(
			"musl",
		);
	});

	it("should not build a process report off Linux", () => {
		expect.assertions(2);

		const getReport = vi.fn<() => object>();
		const host = readHost(
			fromPartial({ arch: "arm64", platform: "darwin", report: { getReport } }),
		);

		expect(host).toStrictEqual({ arch: "arm64", libc: undefined, platform: "darwin" });
		expect(getReport).not.toHaveBeenCalled();
	});
});

describe(createNativeLoader, () => {
	it("should load the platform package when no directory is given", () => {
		expect.assertions(2);

		const { addon } = createFakeNative();
		const requireModule = vi.fn<(id: string) => unknown>().mockReturnValue(addon);

		expect(makeLoader({ requireModule })()).toBe(addon);
		expect(requireModule).toHaveBeenCalledExactlyOnceWith("@rbx-forge/native-win32-x64-msvc");
	});

	it("should load the build in a directory when one is given", () => {
		expect.assertions(1);

		const directory = path.resolve("/native");
		const requireModule = vi.fn<(id: string) => unknown>(() => createFakeNative().addon);
		makeLoader({ directory, requireModule })();

		expect(requireModule).toHaveBeenCalledExactlyOnceWith(
			path.join(directory, "forge-native.win32-x64-msvc.node"),
		);
	});

	it("should load once and keep the addon", () => {
		expect.assertions(2);

		const requireModule = vi.fn<(id: string) => unknown>(() => createFakeNative().addon);
		const load = makeLoader({ requireModule });

		expect(load()).toBe(load());
		expect(requireModule).toHaveBeenCalledOnce();
	});

	it("should read the host only when it loads", () => {
		expect.assertions(1);

		const readHostSpy = vi.fn<() => NativeHost>(() => WINDOWS);
		createNativeLoader({
			directory: undefined,
			readHost: readHostSpy,
			requireModule: () => createFakeNative().addon,
		});

		expect(readHostSpy).not.toHaveBeenCalled();
	});

	it("should fail with native_missing on a host with no build", () => {
		expect.assertions(2);

		const load = makeLoader({ host: { arch: "ia32", libc: undefined, platform: "win32" } });
		const error = catchForgeError(load);

		expect(error.code).toBe("native_missing");
		expect(error.message).toBe("rbx-forge has no native build for win32-ia32.");
	});

	it("should fail with native_missing when the build does not load", () => {
		expect.assertions(4);

		const cause = new Error("Cannot find module");
		const load = makeLoader({
			requireModule: () => {
				throw cause;
			},
		});
		const error = catchForgeError(load);

		expect(error.code).toBe("native_missing");
		expect(error.message).toBe(
			"Could not load @rbx-forge/native-win32-x64-msvc: Cannot find module",
		);
		expect(error.hint).toBe(
			"Reinstall rbx-forge with optional dependencies, or run `pnpm build:native` and set RBX_FORGE_NATIVE_DIR.",
		);
		expect(error.cause).toBe(cause);
	});

	it("should report a thrown value that is not an error", () => {
		expect.assertions(1);

		const load = makeLoader({
			requireModule: () => {
				// oxlint-disable-next-line typescript/only-throw-error -- a native loader may throw anything
				throw "dlopen failed";
			},
		});

		expect(catchForgeError(load).message).toBe(
			"Could not load @rbx-forge/native-win32-x64-msvc: dlopen failed",
		);
	});

	it("should fail with native_missing when the module is not the addon", () => {
		expect.assertions(3);

		const load = makeLoader({ requireModule: () => ({ nativeVersion: () => "0.0.0" }) });
		const error = catchForgeError(load);

		expect(error.code).toBe("native_missing");
		expect(error.message).toBe(
			"@rbx-forge/native-win32-x64-msvc is not the rbx-forge native addon.",
		);
		expect(error.hint).toStartWith("Reinstall rbx-forge");
	});
});

describe(createReaperLocator, () => {
	function makeLocator(options: Partial<ReaperLocateOptions> = {}): () => string {
		return createReaperLocator({
			directory: undefined,
			isExecutable: () => true,
			readHost: () => WINDOWS,
			resolveModule: (id) => path.resolve("/modules", id),
			...options,
		});
	}

	it("should find forge-reaper.exe next to the platform package's manifest", () => {
		expect.assertions(2);

		const resolveModule = vi.fn<(id: string) => string>((id) => path.resolve("/modules", id));

		expect(makeLocator({ resolveModule })()).toBe(
			path.resolve("/modules/@rbx-forge/native-win32-x64-msvc/forge-reaper.exe"),
		);
		expect(resolveModule).toHaveBeenCalledExactlyOnceWith(
			"@rbx-forge/native-win32-x64-msvc/package.json",
		);
	});

	it("should find forge-reaper without an extension off Windows, in a given directory", () => {
		expect.assertions(1);

		const directory = path.resolve("/native");

		expect(makeLocator({ directory, readHost: () => LINUX })()).toBe(
			path.join(directory, "forge-reaper"),
		);
	});

	it("should fail with reaper_unavailable on a host with no build", () => {
		expect.assertions(2);

		const error = catchForgeError(
			makeLocator({
				readHost: () => {
					return { arch: "ia32", libc: undefined, platform: "win32" };
				},
			}),
		);

		expect(error.code).toBe("reaper_unavailable");
		expect(error.message).toBe("rbx-forge has no reaper for win32-ia32.");
	});

	it("should fail with reaper_unavailable when the platform package is missing", () => {
		expect.assertions(4);

		const cause = new Error("Cannot find module");
		const error = catchForgeError(
			makeLocator({
				resolveModule: () => {
					throw cause;
				},
			}),
		);

		expect(error.code).toBe("reaper_unavailable");
		expect(error.message).toBe(
			"Could not find @rbx-forge/native-win32-x64-msvc/package.json: Cannot find module",
		);
		expect(error.hint).toBe(
			"Reinstall rbx-forge with optional dependencies, or run `pnpm build:reaper` and set RBX_FORGE_NATIVE_DIR.",
		);
		expect(error.cause).toBe(cause);
	});

	it("should report a thrown value that is not an error", () => {
		expect.assertions(1);

		const locate = makeLocator({
			resolveModule: () => {
				// oxlint-disable-next-line typescript/only-throw-error -- a resolver may throw anything
				throw "no resolve";
			},
		});

		expect(catchForgeError(locate).message).toBe(
			"Could not find @rbx-forge/native-win32-x64-msvc/package.json: no resolve",
		);
	});

	it("should fail with reaper_unavailable when the binary is missing or cannot run", () => {
		expect.assertions(3);

		const directory = path.resolve("/native");
		const isExecutable = vi.fn<(file: string) => boolean>().mockReturnValue(false);
		const error = catchForgeError(makeLocator({ directory, isExecutable }));

		expect(error.message).toBe(
			`${path.join(directory, "forge-reaper.exe")} is missing or cannot run.`,
		);
		expect(error.hint).toStartWith("Reinstall rbx-forge");
		expect(isExecutable).toHaveBeenCalledExactlyOnceWith(
			path.join(directory, "forge-reaper.exe"),
		);
	});

	it("should read the host only when it looks up", () => {
		expect.assertions(1);

		const readHostSpy = vi.fn<() => NativeHost>(() => WINDOWS);
		makeLocator({ readHost: readHostSpy });

		expect(readHostSpy).not.toHaveBeenCalled();
	});
});
