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
import type { StudioLauncher } from "../studio/launcher.ts";
import stock from "../studio/rojo-plugin/stock.json" with { type: "json" };
import { openStudioAsync } from "./studio-part.ts";

function fixture(sources: Array<string>, fallback = false, prepare = true) {
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
	const studioLauncher = vi.fn<StudioLauncher>(async (launch) => {
		if (prepare) {
			await launch.beforeLaunch?.();
		}

		return fallback
			? { type: "launched" }
			: { studio: { pid: 900, startTime: "1" }, type: "launched" };
	});
	const context = createCommandContext({
		env: { HOME: PROJECT },
		seams: createTestSeams({
			fileSystem: memory.fileSystem,
			host: { ...seams.host, platform: "darwin" },
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
			},
			studioLauncher,
		}),
	});
	const abort = new AbortController();
	const setup = {
		config: resolveConfig({ projectType: "luau" }, {}),
		directory,
		status: {
			rojoPort: () => {},
			service: () => {},
			snapshot: () => makeStatus(),
			studio: () => {},
		},
	};
	return {
		native,
		open: async () => {
			return openStudioAsync(setup, context, { signal: abort.signal }, { isBuilt: true });
		},
	};
}

describe("session Studio plugin capabilities", () => {
	it("should distinguish a lifecycle patch from automatic connection and acknowledgement", async () => {
		expect.assertions(1);

		const run = fixture([stock.App, stock.ServeSession, "protocolVersion = 5,"]);

		await expect(run.open()).resolves.toMatchObject({
			plugin: { autoConnect: false, source: "forge", syncAcknowledgement: false },
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
