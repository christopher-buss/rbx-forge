import path from "node:path";
import { assert, describe, it, vi } from "vitest";

import { createFakeCapture } from "../../test/helpers/fake-capture.ts";
import { createFakeNative } from "../../test/helpers/native.ts";
import {
	createCommandContext,
	createMemoryFileSystem,
	createTestSeams,
	PROJECT,
	TEST_HOSTNAME,
} from "../../test/helpers/seams.ts";
import { runSaveAsync } from "./save.ts";

const PLACE = path.join(PROJECT, "snapshot.rbxl");
const SECRET = "a".repeat(64);

function snapshotSave() {
	const memory = createMemoryFileSystem({
		"snapshot.rbxl": "original",
		"snapshot.rbxl.capture.json": JSON.stringify({
			port: 49152,
			projectName: "snapshot",
			secret: SECRET,
			sessionId: "snapshot-id",
		}),
		"snapshot.rbxl.lock": `42\nRobloxStudioBeta\n${TEST_HOSTNAME}\n`,
		"tools/rojo": "",
	});
	const native = createFakeNative({
		42: {
			alive: true,
			desktop: "hidden",
			executablePath: "RobloxStudioBeta.exe",
			onSaveRequest: "throw",
		},
	});
	native.addon.assemblePlace = (_base, _model, _services, output) => {
		memory.fileSystem.writeFileSync(output, "captured snapshot");
	};

	const listener = createFakeCapture({ model: new Uint8Array([1]), services: [] });
	const close = vi.fn<() => void>(listener.close);
	const seams = createTestSeams({
		configLoader: async () => {
			return {
				path: path.join(PROJECT, "rbx-forge.config.ts"),
				value: {
					projectType: "luau",
					studio: { saveMethod: "capture" },
					syncback: { inputPath: "other.rbxl" },
				},
			};
		},
		fileSystem: memory.fileSystem,
		native: () => native.addon,
		processRunner: async (spec) => {
			memory.fileSystem.writeFileSync(spec.args[spec.args.indexOf("--output") + 1]!, "base");
			return { durationMs: 1, exitCode: 0, outputTail: [], signal: null, type: "exited" };
		},
		randomId: () => "base",
	});
	const listen = vi
		.spyOn(seams.network, "listenForCaptureAsync")
		.mockResolvedValue({ ...listener, close });
	return {
		close,
		context: createCommandContext({ env: { PATH: path.join(PROJECT, "tools") }, seams }),
		listen,
		memory,
		native,
	};
}

describe("snapshot capture saves", () => {
	it("refuses a snapshot whose Studio is no longer open", async ({ expect }) => {
		expect.assertions(1);

		const save = snapshotSave();
		save.memory.fileSystem.rmSync(`${PLACE}.lock`);

		await expect(
			runSaveAsync(save.context, { config: {}, flags: { place: PLACE } }),
		).rejects.toMatchObject({ code: "studio_not_open" });
	});

	it("requires the launch credentials without changing the snapshot", async ({ expect }) => {
		expect.assertions(2);

		const save = snapshotSave();
		save.memory.fileSystem.rmSync(`${PLACE}.capture.json`);

		await expect(
			runSaveAsync(save.context, { config: {}, flags: { place: PLACE } }),
		).rejects.toMatchObject({ code: "capture_not_connected" });
		expect(save.memory.files()["snapshot.rbxl"]).toBe("original");
	});

	it("preserves a listener failure other than an occupied port", async ({ expect }) => {
		expect.assertions(1);

		const save = snapshotSave();
		const failure = new Error("cannot bind");
		save.listen.mockRejectedValueOnce(failure);

		await expect(
			runSaveAsync(save.context, { config: {}, flags: { place: PLACE } }),
		).rejects.toBe(failure);
	});

	it("keeps menu saves available without a config file", async ({ expect }) => {
		expect.assertions(1);

		const save = snapshotSave();
		const studio = save.native.processes.get(42);
		assert(studio !== undefined);
		studio.onSaveRequest = "save";
		save.memory.setModifiedTime("snapshot.rbxl", 1000);
		studio.onSave = () => {
			save.memory.setModifiedTime("snapshot.rbxl", 2000);
		};

		vi.spyOn(save.context.seams, "configLoader").mockResolvedValue(undefined);
		let now = 0;
		save.context.seams.clock = {
			now: () => now,
			sleep: async (ms) => {
				now += ms;
			},
		};

		await expect(
			runSaveAsync(save.context, { config: {}, flags: { place: PLACE } }),
		).resolves.toMatchObject({ data: { pid: 42, place: PLACE } });
	});

	it("reports an occupied capture port without changing the snapshot", async ({ expect }) => {
		expect.assertions(2);

		const save = snapshotSave();
		save.listen.mockRejectedValueOnce(
			Object.assign(new Error("occupied"), { code: "EADDRINUSE" }),
		);

		await expect(
			runSaveAsync(save.context, { config: {}, flags: { place: PLACE } }),
		).rejects.toMatchObject({ code: "capture_port_in_use" });
		expect(save.memory.files()["snapshot.rbxl"]).toBe("original");
	});

	it("binds the recorded endpoint and writes the requested snapshot", async ({ expect }) => {
		expect.assertions(5);

		const save = snapshotSave();

		await expect(
			runSaveAsync(save.context, { config: {}, flags: { place: PLACE } }),
		).resolves.toMatchObject({ data: { desktop: "hidden", pid: 42, place: PLACE } });
		expect(save.listen).toHaveBeenCalledWith(
			{ projectName: "snapshot", sessionId: "snapshot-id" },
			expect.any(AbortSignal),
			{ port: 49152, secret: SECRET },
		);
		expect(save.memory.files()["snapshot.rbxl"]).toBe("captured snapshot");
		expect(save.memory.files()["other.rbxl"]).toBeUndefined();
		expect(save.close).toHaveBeenCalledExactlyOnceWith();
	});
});
