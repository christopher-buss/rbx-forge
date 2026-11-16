import path from "node:path";
import { assert, describe, it } from "vitest";

import { configureModelSources } from "../../test/helpers/model-sources.ts";
import { createFakeNative } from "../../test/helpers/native.ts";
import {
	createCommandContext,
	createMemoryFileSystem,
	createRecordingReporter,
	createTestSeams,
	PROJECT,
} from "../../test/helpers/seams.ts";
import { prepareRojoPluginAsync } from "./rojo-plugin.ts";
import stock from "./rojo-plugin/stock.json" with { type: "json" };

function setup(exitCode = 0, app = stock.App) {
	const memory = createMemoryFileSystem({ "tools/rojo": "" });
	const native = createFakeNative();
	const reporter = createRecordingReporter();
	const specs: Array<{
		args: ReadonlyArray<string>;
		env: Readonly<Record<string, string | undefined>>;
	}> = [];
	const seams = createTestSeams({
		fileSystem: memory.fileSystem,
		native: () => native.addon,
		processRunner: async (spec) => {
			specs.push(spec);
			const home = spec.env["HOME"];
			assert(home !== undefined);
			assert(
				memory.fileSystem.statSync(path.join(home, "AppData/Local/Roblox")).isDirectory(),
			);
			assert(memory.fileSystem.statSync(path.join(home, "studio/content")).isDirectory());
			assert.equal(spec.env["ROBLOX_STUDIO_PATH"], path.join(home, "studio"));
			const folder = path.join(home, "AppData/Local/Roblox/Plugins");
			memory.fileSystem.mkdirSync(folder, { recursive: true });
			const model = path.join(folder, "RojoManagedPlugin.rbxm");
			memory.fileSystem.writeFileSync(model, "installed");
			const sources = [app, stock.ServeSession, "protocolVersion = 5,"];
			configureModelSources(native.addon, sources, model);
			const write = native.addon.writeModelScriptSources;
			native.addon.writeModelScriptSources = (file, scripts) => {
				write(file, scripts);
				memory.fileSystem.writeFileSync(file, sources.join("\n"));
			};

			return { durationMs: 1, exitCode, outputTail: [], signal: null, type: "exited" };
		},
		randomId: () => "install",
	});
	seams.studioHost.pluginsFolderAsync = async () => path.join(PROJECT, "windows/plugins");
	const context = createCommandContext({
		env: { HOME: "/original", PATH: path.join(PROJECT, "tools"), WSL_DISTRO_NAME: "fixture" },
		reporter,
		seams,
	});
	return { context, memory, reporter, specs };
}

const SERVER = { protocolVersion: 5, serverVersion: "7.7.1" };

describe("wsl managed Rojo plugin preparation", () => {
	it.for(["rojo.exe", "rojo.COM"])(
		"does not run a Windows installer with Linux staging paths",
		async (alias, { expect }) => {
			expect.assertions(3);

			const { context, memory, reporter, specs } = setup();
			memory.fileSystem.renameSync(
				path.join(PROJECT, "tools/rojo"),
				path.join(PROJECT, "tools", alias),
			);

			await expect(
				prepareRojoPluginAsync(
					context,
					{ rojoAlias: alias },
					SERVER,
					AbortSignal.timeout(10_000),
				),
			).resolves.toHaveProperty("source", "manual");
			expect(specs).toEqual([]);
			expect(reporter.events).toContainEqual({
				message:
					"The Windows Rojo installer is not verified with Linux staging paths. Auto-connect is off; connect to Rojo manually in Studio.",
				type: "warning",
			});
		},
	);

	it("preserves a staging directory that belongs to another install", async ({ expect }) => {
		expect.assertions(2);

		const { context, memory } = setup();
		const occupied = path.join(PROJECT, ".forge/plugin-install-install");
		memory.fileSystem.mkdirSync(occupied, { recursive: true });
		memory.fileSystem.writeFileSync(path.join(occupied, "owned"), "keep");

		await expect(
			prepareRojoPluginAsync(
				context,
				{ rojoAlias: "rojo" },
				SERVER,
				AbortSignal.timeout(10_000),
			),
		).rejects.toMatchObject({ code: "EEXIST" });
		expect(memory.fileSystem.readFileSync(path.join(occupied, "owned"), "utf8")).toBe("keep");
	});

	it.for([stock.App, "unknown"])(
		"does not publish after cancellation during installation",
		async (app, { expect }) => {
			expect.assertions(2);

			const { context, memory } = setup(0, app);
			const controller = new AbortController();
			const run = context.seams.processRunner;
			context.seams.processRunner = async (spec) => {
				const result = await run(spec);
				controller.abort();
				return result;
			};

			await expect(
				prepareRojoPluginAsync(context, { rojoAlias: "rojo" }, SERVER, controller.signal),
			).rejects.toThrow("aborted");
			expect(memory.files()).toEqual({ ".forge": null, "tools/rojo": "" });
		},
	);

	it("does not publish unrecognized installed sources", async ({ expect }) => {
		expect.assertions(2);

		const { context, memory } = setup(0, "unknown");

		await expect(
			prepareRojoPluginAsync(
				context,
				{ rojoAlias: "rojo" },
				SERVER,
				AbortSignal.timeout(10_000),
			),
		).resolves.toHaveProperty("source", "manual");
		expect(memory.files()).toEqual({ ".forge": null, "tools/rojo": "" });
	});

	it("reports a publication failure and removes both temporary copies", async ({ expect }) => {
		expect.assertions(2);

		const { context, memory } = setup();
		context.seams.fileSystem.renameSync = () => {
			throw new Error("denied");
		};

		await expect(
			prepareRojoPluginAsync(
				context,
				{ rojoAlias: "rojo" },
				SERVER,
				AbortSignal.timeout(10_000),
			),
		).rejects.toMatchObject({
			code: "plugin_write_failed",
			hint: `Check permissions on ${path.join(PROJECT, "windows/plugins/RojoManagedPlugin.rbxm")} and retry.`,
			message: "Could not install the managed Rojo plugin: denied",
		});
		expect(memory.files()).toEqual({
			".forge": null,
			"tools/rojo": "",
			"windows/plugins": null,
		});
	});

	it("warns and leaves Windows plugins untouched for unverified Rojo", async ({ expect }) => {
		expect.assertions(3);

		const { context, reporter, specs } = setup();

		await expect(
			prepareRojoPluginAsync(
				context,
				{ rojoAlias: "rojo" },
				{ ...SERVER, serverVersion: "7.8.0" },
				AbortSignal.timeout(10_000),
			),
		).resolves.toEqual({ autoConnect: false, source: "manual", syncAcknowledgement: false });
		expect(specs).toEqual([]);
		expect(reporter.events).toContainEqual({
			message:
				"Rojo 7.8.0 plugin installation under WSL is not verified. Auto-connect is off; connect to Rojo manually in Studio.",
			type: "warning",
		});
	});

	it("cleans staging after an install failure without publishing a plugin", async ({
		expect,
	}) => {
		expect.assertions(2);

		const { context, memory } = setup(1);

		await expect(
			prepareRojoPluginAsync(
				context,
				{ rojoAlias: "rojo" },
				SERVER,
				AbortSignal.timeout(10_000),
			),
		).rejects.toMatchObject({ code: "process_failed" });
		expect(memory.files()).toEqual({ ".forge": null, "tools/rojo": "" });
	});

	it("stages the session Rojo plugin under a private HOME before installing to Windows", async ({
		expect,
	}) => {
		expect.assertions(5);

		const { context, memory, specs } = setup();
		memory.fileSystem.mkdirSync(path.join(PROJECT, ".forge"));

		await expect(
			prepareRojoPluginAsync(
				context,
				{ rojoAlias: "rojo" },
				SERVER,
				AbortSignal.timeout(10_000),
			),
		).resolves.toEqual({ autoConnect: true, source: "forge", syncAcknowledgement: true });
		expect(specs.map(({ args }) => args)).toEqual([["plugin", "install"]]);
		expect(memory.files()["windows/plugins/RojoManagedPlugin.rbxm"]).toContain(
			"-- rbx-forge patch 4 stock f7facea2cd39479ede1349b0042633c8228b8a41d602831f1928a1e43f7b1f15\n",
		);
		expect(memory.fileSystem.readdirSync(path.join(PROJECT, ".forge"))).toEqual([]);
		expect(context.env["HOME"]).toBe("/original");
	});
});
