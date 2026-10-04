import path from "node:path";
import { assert, describe, expect, it } from "vitest";

import { createMemoryTransport } from "../../test/helpers/fake-ipc.ts";
import { serveFakeSessionAsync } from "../../test/helpers/fake-session.ts";
import { createFakeNative } from "../../test/helpers/native.ts";
import {
	createCommandContext,
	createMemoryFileSystem,
	createTestSeams,
	PROJECT,
	TEST_HOSTNAME,
} from "../../test/helpers/seams.ts";
import { runSaveAsync } from "./save.ts";

const SNAPSHOT = ".forge/snapshots/example.rbxl";
const PLACE = path.join(PROJECT, SNAPSHOT);

function snapshotProject(desktop: "hidden" | "user" = "user") {
	const memory = createMemoryFileSystem({
		[`${SNAPSHOT}.lock`]: `42\nRobloxStudioBeta\n${TEST_HOSTNAME}\n`,
		[SNAPSHOT]: "snapshot",
	});
	memory.setModifiedTime(SNAPSHOT, 1000);
	const native = createFakeNative({
		42: {
			alive: true,
			desktop,
			executablePath: "RobloxStudioBeta.exe",
			onSave: () => {
				memory.fileSystem.writeFileSync(PLACE, "saved snapshot");
				memory.setModifiedTime(SNAPSHOT, 2000);
			},
		},
	});
	let now = 0;
	const seams = createTestSeams({
		clock: {
			now: () => now,
			sleep: async (ms) => {
				now += ms;
			},
		},
		fileSystem: memory.fileSystem,
		native: () => native.addon,
	});
	return { context: createCommandContext({ seams }), memory, native };
}

describe("saving snapshot Studios", () => {
	it("saves the snapshot directly when the project also has a session", async () => {
		expect.assertions(1);

		const { context, memory } = snapshotProject("hidden");
		const ipc = createMemoryTransport();
		const session = await serveFakeSessionAsync(memory, ipc);
		session.save = () => {
			throw new Error("The session Studio is a different place.");
		};

		await expect(
			runSaveAsync(
				{ ...context, seams: { ...context.seams, ipc } },
				{ config: {}, flags: { place: SNAPSHOT } },
			),
		).resolves.toMatchObject({ data: { desktop: "hidden", place: PLACE } });
	});

	it("reports studio_not_open when the snapshot has no lock", async () => {
		expect.assertions(2);

		const { context, memory } = snapshotProject();
		memory.fileSystem.rmSync(`${PLACE}.lock`);

		await expect(
			runSaveAsync(context, { config: {}, flags: { place: SNAPSHOT } }),
		).rejects.toMatchObject({ code: "studio_not_open" });
		expect(memory.fileSystem.readFileSync(PLACE, "utf8")).toBe("snapshot");
	});

	it.for([
		{
			name: "foreign host",
			alive: true,
			executablePath: "RobloxStudioBeta.exe",
			lock: "42\nRobloxStudioBeta\nother-machine\n",
			startTime: "42",
		},
		{
			name: "malformed PID",
			alive: true,
			executablePath: "RobloxStudioBeta.exe",
			lock: "not-a-pid\nRobloxStudioBeta\n",
			startTime: "42",
		},
		{
			name: "exited process",
			alive: false,
			executablePath: "RobloxStudioBeta.exe",
			lock: `42\nRobloxStudioBeta\n${TEST_HOSTNAME}\n`,
			startTime: "42",
		},
		{
			name: "different executable",
			alive: true,
			executablePath: "another.exe",
			lock: `42\nRobloxStudioBeta\n${TEST_HOSTNAME}\n`,
			startTime: "42",
		},
		{
			name: "reused PID",
			alive: true,
			executablePath: "RobloxStudioBeta.exe",
			lock: `42\nRobloxStudioBeta\n${TEST_HOSTNAME}\n`,
			startTime: "1000",
		},
	])("refuses a snapshot lock with $name", async ({ alive, executablePath, lock, startTime }) => {
		expect.assertions(2);

		const { context, memory, native } = snapshotProject();
		memory.fileSystem.writeFileSync(`${PLACE}.lock`, lock);
		memory.setModifiedTime(`${SNAPSHOT}.lock`, 0);
		const studio = native.processes.get(42);
		assert(studio !== undefined);
		Object.assign(studio, { alive, executablePath, startTime });

		await expect(
			runSaveAsync(context, { config: {}, flags: { place: SNAPSHOT } }),
		).rejects.toMatchObject({ code: "studio_not_open" });
		expect(memory.fileSystem.readFileSync(PLACE, "utf8")).toBe("snapshot");
	});

	it("reports the actual hidden desktop for a snapshot without session state", async () => {
		expect.assertions(1);

		const { context } = snapshotProject("hidden");

		await expect(
			runSaveAsync(context, { config: {}, flags: { place: SNAPSHOT } }),
		).resolves.toMatchObject({ data: { desktop: "hidden", pid: 42, place: PLACE } });
	});

	it("saves directly without a running session", async () => {
		expect.assertions(2);

		const { context, memory } = snapshotProject();
		const result = await runSaveAsync(context, { config: {}, flags: { place: SNAPSHOT } });

		expect(result.data).toStrictEqual({
			bytes: 14,
			desktop: "user",
			durationMs: 300,
			mtime: "1970-01-01T00:00:02.000Z",
			pid: 42,
			place: PLACE,
		});
		expect(memory.fileSystem.readFileSync(PLACE, "utf8")).toBe("saved snapshot");
	});
});
