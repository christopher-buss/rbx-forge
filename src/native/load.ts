import { type } from "arktype";
import path from "node:path";

import { ForgeError } from "../errors.ts";
import type { NativeAddon, NativeLoader } from "./addon.ts";

/** The facts that pick a native build. */
export interface NativeHost {
	/** `process.arch`. */
	arch: string;
	/** The C library on Linux; `undefined` elsewhere. */
	libc: "gnu" | "musl" | undefined;
	/** `process.platform`. */
	platform: string;
}

/** The process members {@link readHost} reads. */
export type HostProcess = Pick<NodeJS.Process, "arch" | "platform" | "report">;

/** How {@link createNativeLoader} finds and loads the addon. */
export interface NativeLoadOptions {
	/**
	 * A directory that holds `forge-native.<target>.node` (the output of
	 * `pnpm build:native`), used in place of the platform package. The CLI
	 * entry sets it from `RBX_FORGE_NATIVE_DIR` for development and tests.
	 */
	directory: string | undefined;
	/** Read the host facts; called only when the addon loads. */
	readHost: () => NativeHost;
	/** Load a module by package name or path (`createRequire`). */
	requireModule: (id: string) => unknown;
}

/**
 * Every native build, named as napi names them: `@rbx-forge/native-<target>`
 * holds `forge-native.<target>.node`. One per `package.json#napi.targets`.
 */
const TARGETS: ReadonlySet<string> = new Set([
	"darwin-arm64",
	"darwin-x64",
	"linux-arm64-gnu",
	"linux-arm64-musl",
	"linux-x64-gnu",
	"linux-x64-musl",
	"win32-arm64-msvc",
	"win32-x64-msvc",
]);

const PACKAGE_PREFIX = "@rbx-forge/native-";
const LOAD_HINT =
	"Reinstall rbx-forge with optional dependencies, or run `pnpm build:native` and set RBX_FORGE_NATIVE_DIR.";

/** Enough of the addon's shape to tell it from another module. */
const addonShape = type({
	nativeVersion: "Function",
	pinProcess: "Function",
	processStartTime: "Function",
	tryLockFile: "Function",
});

const reportShape = type({ header: { "glibcVersionRuntime?": "string" } });

/**
 * Name the native build for a host.
 *
 * @param host - Platform, architecture, and C library.
 * @returns The napi target name, or `undefined` when no build exists.
 */
export function nativeTarget({ arch, libc, platform }: NativeHost): string | undefined {
	// Only Linux builds name a C library; a libc on another platform names
	// no build.
	const abi = platform === "win32" ? "msvc" : libc;
	const target = [platform, arch, abi].filter((part) => part !== undefined).join("-");
	return TARGETS.has(target) ? target : undefined;
}

/**
 * Read the host facts from a Node process. On Linux the C library comes from
 * the process report: a glibc build reports its glibc version; musl reports
 * none.
 *
 * @param process - The running Node process (`node:process`).
 * @returns Platform, architecture, and C library.
 */
export function readHost({ arch, platform, report }: HostProcess): NativeHost {
	if (platform !== "linux") {
		return { arch, libc: undefined, platform };
	}

	const { header } = reportShape.assert(report.getReport());
	return { arch, libc: header.glibcVersionRuntime === undefined ? "musl" : "gnu", platform };
}

/**
 * Make the loader that the seams hand to commands. It loads the addon on
 * first use and keeps it.
 *
 * @param options - The addon directory, host reader, and module loader.
 * @returns A loader that loads the addon once, then returns it.
 */
export function createNativeLoader(options: NativeLoadOptions): NativeLoader {
	let addon: NativeAddon | undefined;
	return () => {
		addon ??= loadAddon(options);
		return addon;
	};
}

function loadAddon({ directory, readHost: hostOf, requireModule }: NativeLoadOptions): NativeAddon {
	const host = hostOf();
	const target = nativeTarget(host);
	if (target === undefined) {
		throw new ForgeError(
			"native_missing",
			`rbx-forge has no native build for ${host.platform}-${host.arch}.`,
		);
	}

	const id =
		directory === undefined
			? `${PACKAGE_PREFIX}${target}`
			: path.join(directory, `forge-native.${target}.node`);

	let loaded: unknown;
	try {
		loaded = requireModule(id);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		throw new ForgeError("native_missing", `Could not load ${id}: ${reason}`, {
			cause: err,
			hint: LOAD_HINT,
		});
	}

	if (!addonShape.allows(loaded)) {
		throw new ForgeError("native_missing", `${id} is not the rbx-forge native addon.`, {
			hint: LOAD_HINT,
		});
	}

	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `addonShape` checked the exports; their signatures come from `reaper/src/lib.rs`.
	return loaded as unknown as NativeAddon;
}
