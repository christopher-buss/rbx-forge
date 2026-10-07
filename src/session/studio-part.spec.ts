import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { makeStatus } from "../../test/helpers/fake-session.ts";
import { configureModelSources } from "../../test/helpers/model-sources.ts";
import { createFakeNative } from "../../test/helpers/native.ts";
import {
	createCommandContext,
	createMemoryFileSystem,
	createTestSeams,
	PROJECT,
} from "../../test/helpers/seams.ts";
import { resolveConfig } from "../config/resolve.ts";
import type { StudioDesktop } from "../config/schema.ts";
import type { StudioLauncher } from "../studio/launcher.ts";
import { SCRIPTS, VERSION } from "../studio/rojo-plugin.ts";
import stock from "../studio/rojo-plugin/stock.json" with { type: "json" };
import { openStudioAsync } from "./studio-part.ts";

function fixture(
	sources: Array<string>,
	fallback = false,
	prepare = true,
	{
		beforePrepare,
		desktop,
	}: {
		beforePrepare?: (abort: AbortController) => void;
		desktop?: {
			default?: StudioDesktop;
			file?: StudioDesktop;
			flag?: StudioDesktop;
			platform: NodeJS.Platform;
		};
	} = {},
) {
	const directory = path.join(PROJECT, "session");
	const memory = createMemoryFileSystem({
		"Documents/Roblox/Plugins/RojoManagedPlugin.rbxm": "model",
		"session/rojo.project.json": '{"name":"Example@abc"}',
	});
	const native = createFakeNative();
	configureModelSources(
		native.addon,
		sources,
		path.join(PROJECT, "Documents", "Roblox", "Plugins", "RojoManagedPlugin.rbxm"),
	);
	const seams = createTestSeams();
	const write = vi.spyOn(native.addon, "writeModelScriptSources");
	const close = vi.fn<() => void>();
	const studioLauncher = vi.fn<StudioLauncher>(async (launch) => {
		if (prepare) {
			beforePrepare?.(abort);
			await launch.beforeLaunch?.();
		}

		return fallback
			? { type: "launched" }
			: {
					studio: {
						pid: 900,
						startTime: "1",
						...(launch.desktop === undefined ? {} : { desktop: launch.desktop }),
					},
					type: "launched",
				};
	});
	const context = createCommandContext({
		env: { HOME: PROJECT },
		seams: createTestSeams({
			fileSystem: memory.fileSystem,
			host: { ...seams.host, platform: desktop?.platform ?? "darwin" },
			native: () => native.addon,
			network: {
				...seams.network,
				getRojoInfoAsync: async () => {
					return {
						projectName: "Example@abc",
						protocolVersion: 5,
						serverVersion: "7.7.1",
						sessionId: "s1",
					};
				},
				listenForStudioReadyAsync: async () => {
					return {
						close,
						ready: Promise.resolve(true),
						url: "http://127.0.0.1:50001/ready/test",
					};
				},
			},
			processRunner: seams.processRunner,
			studioLauncher,
		}),
	});
	const abort = new AbortController();
	const setup = {
		config: resolveConfig(
			{
				projectType: "luau",
				studio: desktop?.file === undefined ? {} : { desktop: desktop.file },
			},
			{},
		),
		directory,
		status: {
			rojoPort: () => {},
			service: () => {},
			snapshot: () => makeStatus(),
			studio: () => {},
		},
	};
	return {
		abort,
		close,
		context,
		memory,
		native,
		open: async () => {
			return openStudioAsync(
				setup,
				context,
				{ defaultDesktop: desktop?.default, desktop: desktop?.flag, signal: abort.signal },
				{ isBuilt: true },
			);
		},
		processRunner: seams.processRunner,
		write,
	};
}

describe("session Studio plugin capabilities", () => {
	it("should recognize the current patched bodies without rewriting them", async () => {
		expect.assertions(2);

		const sources = SCRIPTS.map(
			({ hash, source }) => `-- rbx-forge patch ${VERSION} stock ${hash}\n${source}`,
		);
		const run = fixture([...sources, "return { protocolVersion = 5 }"]);

		await expect(run.open()).resolves.toMatchObject({
			plugin: { autoConnect: true, source: "forge", syncAcknowledgement: true },
		});
		expect(run.write).not.toHaveBeenCalled();
	});

	it("should repair a pair containing one current patch and one stock body", async () => {
		expect.assertions(2);

		const app = SCRIPTS[0]!;
		const run = fixture([
			`-- rbx-forge patch 3 stock ${app.hash}\n${app.source}`,
			stock.ServeSession,
			"return { protocolVersion = 5 }",
		]);

		await expect(run.open()).resolves.toMatchObject({ plugin: { source: "forge" } });
		expect(run.write).toHaveBeenCalledOnce();
	});

	it.for([stock.App, "return 'manually changed'"])(
		"should preserve an unsupported body marked as current",
		async (source) => {
			expect.assertions(2);

			const run = fixture([
				`-- rbx-forge patch 3 stock f7facea2cd39479ede1349b0042633c8228b8a41d602831f1928a1e43f7b1f15\n${source}`,
				stock.ServeSession,
				"return { protocolVersion = 5 }",
			]);

			await expect(run.open()).resolves.toMatchObject({ plugin: { source: "manual" } });
			expect(run.write).not.toHaveBeenCalled();
		},
	);

	it("should cancel after reading identity before binding a callback", async () => {
		expect.assertions(2);

		const run = fixture([stock.App, stock.ServeSession, "return { protocolVersion = 5 }"]);
		const original = run.context.seams.network.getRojoInfoAsync;
		run.context.seams.network.getRojoInfoAsync = async (...parameters) => {
			const info = await original(...parameters);
			run.abort.abort();
			return info;
		};

		const listen = vi.spyOn(run.context.seams.network, "listenForStudioReadyAsync");

		await expect(run.open()).rejects.toMatchObject({ name: "AbortError" });
		expect(listen).not.toHaveBeenCalled();
	});

	it("should dispose a callback cancelled during binding before writing the marker", async () => {
		expect.assertions(3);

		const run = fixture([stock.App, stock.ServeSession, "return { protocolVersion = 5 }"]);
		const original = run.context.seams.network.listenForStudioReadyAsync;
		run.context.seams.network.listenForStudioReadyAsync = async (...parameters) => {
			const listener = await original(...parameters);
			run.abort.abort();
			return listener;
		};

		await expect(run.open()).rejects.toMatchObject({ name: "AbortError" });
		expect(
			run.memory.fileSystem.existsSync(path.join(PROJECT, "session/studio-marker.lua")),
		).toBeFalse();
		expect(run.close).toHaveBeenCalledOnce();
	});

	it("should report a direct launcher that bypasses preparation as manual", async () => {
		expect.assertions(2);

		const run = fixture([stock.App, stock.ServeSession, "protocolVersion = 5,"], false, false);

		await expect(run.open()).resolves.toMatchObject({
			plugin: { autoConnect: false, source: "manual", syncAcknowledgement: false },
		});
		expect(run.close).toHaveBeenCalledOnce();
	});

	it("should cancel before plugin preparation without installing or writing", async () => {
		expect.assertions(4);

		const run = fixture([stock.App, stock.ServeSession, "protocolVersion = 5,"], false, true, {
			beforePrepare: (abort) => {
				abort.abort();
			},
		});
		run.memory.fileSystem.rmSync(
			path.join(PROJECT, "Documents/Roblox/Plugins/RojoManagedPlugin.rbxm"),
		);
		const write = vi.spyOn(run.native.addon, "writeModelScriptSources");

		await expect(run.open()).rejects.toMatchObject({ name: "AbortError" });
		expect(run.processRunner).not.toHaveBeenCalled();
		expect(write).not.toHaveBeenCalled();
		expect(run.close).toHaveBeenCalledOnce();
	});

	it("should cancel after reading a current plugin before Studio launches", async () => {
		expect.assertions(3);

		const sources = SCRIPTS.map(
			({ hash, source }) => `-- rbx-forge patch ${VERSION} stock ${hash}\n${source}`,
		);
		const run = fixture([...sources, "protocolVersion = 5,"]);
		const read = run.native.addon.readModelScriptSources;
		run.native.addon.readModelScriptSources = (...args) => {
			const result = read(...args);
			run.abort.abort();
			return result;
		};

		const write = vi.spyOn(run.native.addon, "writeModelScriptSources");

		await expect(run.open()).rejects.toMatchObject({ name: "AbortError" });
		expect(write).not.toHaveBeenCalled();
		expect(run.close).toHaveBeenCalledOnce();
	});

	it("should promise automatic connection and acknowledgement for the managed patch", async () => {
		expect.assertions(1);

		const run = fixture([stock.App, stock.ServeSession, "protocolVersion = 5,"]);

		await expect(run.open()).resolves.toMatchObject({
			plugin: { autoConnect: true, source: "forge", syncAcknowledgement: true },
		});
	});

	it("should preserve upstream marker support without promising automatic sync", async () => {
		expect.assertions(1);

		const run = fixture(["ROJO_OPEN_", "expectedSessionId", "protocolVersion = 5,"]);

		await expect(run.open()).resolves.toMatchObject({
			plugin: { autoConnect: false, source: "upstream", syncAcknowledgement: false },
		});
	});

	it("should identify an unknown plugin as manual", async () => {
		expect.assertions(1);

		const run = fixture(["unknown", "unknown", "protocolVersion = 5,"]);

		await expect(run.open()).resolves.toMatchObject({
			plugin: { autoConnect: false, source: "manual", syncAcknowledgement: false },
		});
	});

	it("should reset managed capabilities when a direct launch falls back after preparation", async () => {
		expect.assertions(1);

		const run = fixture([stock.App, stock.ServeSession, "protocolVersion = 5,"], true);

		await expect(run.open()).resolves.toMatchObject({
			plugin: { autoConnect: false, source: "manual", syncAcknowledgement: false },
			studio: null,
		});
	});

	it("should preserve the plugin when the platform launcher bypasses preparation", async () => {
		expect.assertions(2);

		const run = fixture([stock.App, stock.ServeSession, "protocolVersion = 5,"], true, false);
		const write = vi.spyOn(run.native.addon, "writeModelScriptSources");

		await expect(run.open()).resolves.toMatchObject({
			plugin: { autoConnect: false, source: "manual", syncAcknowledgement: false },
		});
		expect(write).not.toHaveBeenCalled();
	});
});

describe("session Studio desktop", () => {
	it.for([
		{ default: "hidden", expected: "hidden", platform: "win32" },
		{ default: "user", expected: "user", platform: "win32" },
		{ default: "hidden", expected: "user", file: "user", platform: "win32" },
		{ default: "user", expected: "hidden", file: "hidden", platform: "win32" },
		{ default: "hidden", expected: "user", file: "hidden", flag: "user", platform: "win32" },
		{ default: "user", expected: "hidden", file: "user", flag: "hidden", platform: "win32" },
		{ default: "hidden", expected: "hidden", platform: "darwin" },
		{ default: "user", expected: "user", platform: "darwin" },
		{ default: "user", expected: "hidden", file: "hidden", platform: "darwin" },
		{ default: "hidden", expected: "user", file: "hidden", flag: "user", platform: "darwin" },
		{ default: "user", expected: "hidden", file: "user", flag: "hidden", platform: "darwin" },
		{ default: "hidden", expected: "user", platform: "linux" },
		{ expected: "user", flag: "hidden", platform: "linux" },
		{ expected: "user", file: "hidden", platform: "linux" },
	] as const)(
		"should resolve $platform default=$default file=$file flag=$flag as $expected",
		async (desktop) => {
			expect.assertions(1);

			const run = fixture(
				[stock.App, stock.ServeSession, "protocolVersion = 5,"],
				false,
				true,
				{ desktop },
			);

			await expect(run.open()).resolves.toMatchObject({
				studio: { desktop: desktop.expected },
			});
		},
	);
});
