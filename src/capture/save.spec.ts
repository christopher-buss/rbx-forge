import { fromPartial } from "@total-typescript/shoehorn";

import path from "node:path";
import { describe, it } from "vitest";

import { createFakeCapture } from "../../test/helpers/fake-capture.ts";
import {
	createCommandContext,
	createMemoryFileSystem,
	createTestSeams,
	PROJECT,
} from "../../test/helpers/seams.ts";
import { resolveConfig } from "../config/resolve.ts";
import { ForgeError } from "../errors.ts";
import type { CaptureListener } from "./protocol.ts";
import { saveCaptureAsync } from "./save.ts";
import type { CaptureSaveOptions } from "./save.ts";

function captureSave(
	overrides: {
		assemble?: () => void;
		build?: () => void;
		capture?: CaptureListener;
		controller?: AbortController;
		studio?: CaptureSaveOptions["studio"];
		timeout?: boolean;
	} = {},
) {
	const memory = createMemoryFileSystem({
		"game.rbxl": "original",
		"sync.rbxl": "previous syncback",
		"tools/rojo": "",
	});
	const controller = overrides.controller ?? new AbortController();
	const context = createCommandContext({
		env: { PATH: path.join(PROJECT, "tools") },
		seams: createTestSeams({
			fileSystem: memory.fileSystem,
			native: () => {
				return fromPartial({
					assemblePlace: (
						base: string,
						_model: Uint8Array,
						_services: string,
						output: string,
					) => {
						overrides.assemble?.();
						memory.fileSystem.writeFileSync(
							output,
							`${memory.fileSystem.readFileSync(base, "utf8")} | Studio capture`,
						);
					},
				});
			},
			processRunner: async (spec) => {
				const index = spec.args.indexOf("--output");
				memory.fileSystem.writeFileSync(spec.args[index + 1]!, `base: ${spec.args[1]}`);
				overrides.build?.();
				return overrides.timeout === true
					? { durationMs: 1000, outputTail: [], type: "timed_out" }
					: { durationMs: 1, exitCode: 0, outputTail: [], signal: null, type: "exited" };
			},
			randomId: () => "capture",
		}),
	});
	return {
		controller,
		memory,
		run: async (custom = false) => {
			return saveCaptureAsync(
				context,
				resolveConfig(
					{
						projectType: "luau",
						syncback: custom
							? { inputPath: "sync.rbxl", projectPath: "sync.project.json" }
							: {},
					},
					{},
				),
				{
					deadline: context.seams.clock.now() + 1000,
					listener:
						overrides.capture ??
						createFakeCapture({ model: new Uint8Array([1]), services: [] }),
					signal: controller.signal,
					studio:
						overrides.studio ??
						(custom
							? { desktop: "hidden", place: "game.rbxl" }
							: { desktop: "user", pid: 42, place: "game.rbxl" }),
				},
			);
		},
	};
}

describe(saveCaptureAsync, () => {
	it("reports the user desktop when the connected Studio has no recorded process identity", async ({
		expect,
	}) => {
		expect.assertions(1);

		const save = captureSave({ studio: { place: "game.rbxl" } });

		await expect(save.run()).resolves.toMatchObject({ desktop: "user", pid: 0 });
	});

	it("builds the current syncback project and writes its configured input", async ({
		expect,
	}) => {
		expect.assertions(3);

		const save = captureSave();

		await expect(save.run(true)).resolves.toMatchObject({
			desktop: "hidden",
			pid: 0,
			place: path.join(PROJECT, "sync.rbxl"),
		});
		expect(save.memory.files()["sync.rbxl"]).toBe("base: sync.project.json | Studio capture");
		expect(save.memory.files()["game.rbxl"]).toBe("original");
	});

	it("keeps the current place and removes the temporary base when assembly fails", async ({
		expect,
	}) => {
		expect.assertions(3);

		const save = captureSave({
			assemble: () => {
				throw new Error("invalid model");
			},
		});

		await expect(save.run()).rejects.toMatchObject({ code: "capture_assembly_failed" });
		expect(save.memory.files()["game.rbxl"]).toBe("original");
		expect(Object.keys(save.memory.files())).not.toContain(".forge-capture-capture.rbxl");
	});

	it("preserves Studio's capture rejection and leaves the place untouched", async ({
		expect,
	}) => {
		expect.assertions(2);

		const save = captureSave({
			capture: createFakeCapture(new ForgeError("capture_rejected", "Play mode")),
		});

		await expect(save.run()).rejects.toMatchObject({
			code: "capture_rejected",
			message: "Play mode",
		});
		expect(save.memory.files()["game.rbxl"]).toBe("original");
	});

	it("rejects an already cancelled capture before building", async ({ expect }) => {
		expect.assertions(2);

		const controller = new AbortController();
		controller.abort();
		const save = captureSave({ controller });

		await expect(save.run()).rejects.toMatchObject({ name: "AbortError" });
		expect(save.memory.files()["game.rbxl"]).toBe("original");
	});

	it("does not ask Studio for a capture when its base build outlives cancellation", async ({
		expect,
	}) => {
		expect.assertions(2);

		const controller = new AbortController();
		const save = captureSave({
			build: () => {
				controller.abort();
			},
			controller,
		});

		await expect(save.run()).rejects.toMatchObject({ name: "AbortError" });
		expect(save.memory.files()["game.rbxl"]).toBe("original");
	});

	it("does not assemble a capture that finished after its request was cancelled", async ({
		expect,
	}) => {
		expect.assertions(2);

		const controller = new AbortController();
		const capture = createFakeCapture({ model: new Uint8Array(), services: [] });
		capture.captureAsync = async () => {
			controller.abort();
			return { model: new Uint8Array(), services: [] };
		};

		const save = captureSave({ capture, controller });

		await expect(save.run()).rejects.toMatchObject({ name: "AbortError" });
		expect(save.memory.files()["game.rbxl"]).toBe("original");
	});

	it("bounds the base build by the capture deadline", async ({ expect }) => {
		expect.assertions(2);

		const save = captureSave({ timeout: true });

		await expect(save.run()).rejects.toMatchObject({ code: "capture_timeout" });
		expect(save.memory.files()["game.rbxl"]).toBe("original");
	});
});
