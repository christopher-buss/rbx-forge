import { describe, expect, it } from "vitest";

import { createMemoryTransport } from "../../test/helpers/fake-ipc.ts";
import { serveFakeSessionAsync } from "../../test/helpers/fake-session.ts";
import {
	createCommandContext,
	createMemoryFileSystem,
	createRecordingReporter,
	createTestSeams,
} from "../../test/helpers/seams.ts";
import type { IpcConnection } from "../ipc/connection.ts";
import { runShowAsync } from "./show.ts";

const MOVED = {
	durationMs: 1000,
	from: "hidden",
	pid: 43,
	save: {
		bytes: 500,
		desktop: "hidden",
		durationMs: 100,
		mtime: "2026-01-01T00:00:00Z",
		pid: 42,
		place: "/project/game.rbxl",
	},
	to: "user",
};

async function movingSessionAsync(platform: NodeJS.Platform = "win32") {
	const memory = createMemoryFileSystem();
	const ipc = createMemoryTransport();
	const session = await serveFakeSessionAsync(memory, ipc);
	session.moveStudio = () => MOVED;
	const reporter = createRecordingReporter();
	const context = createCommandContext({
		reporter,
		seams: createTestSeams({
			fileSystem: memory.fileSystem,
			host: { ...createTestSeams().host, platform },
			ipc,
		}),
	});
	return { context, reporter, session };
}

function delayedMove(responseAfterMs: number): IpcConnection {
	return {
		close: () => {},
		readLineAsync: async (timeoutMs) => {
			if (timeoutMs < responseAfterMs) {
				return { type: "timed_out" };
			}

			return {
				line: JSON.stringify({ ok: true, result: MOVED, type: "response" }),
				type: "line",
			};
		},
		writeAsync: async () => true,
	};
}

describe("move command validation", () => {
	it("reports the actual desktop and explains the reopen cost", async () => {
		expect.assertions(2);

		const { context, reporter } = await movingSessionAsync();

		await expect(runShowAsync(context, { config: {}, flags: {} })).resolves.toStrictEqual({
			data: MOVED,
			summary: "Studio is on the user desktop (PID 43).",
		});
		expect(reporter.events).toContainEqual({
			message: "Reopening Studio loses undo history and open script tabs.",
			type: "warning",
		});
	});

	it("allows the save, reopen deadline, and cleanup response grace to elapse", async () => {
		expect.assertions(1);

		const { context } = await movingSessionAsync();
		context.seams.ipc.connectAsync = async () => delayedMove(240_500);

		await expect(
			runShowAsync(context, { config: {}, flags: { timeout: "1" } }),
		).resolves.toStrictEqual({
			data: MOVED,
			summary: "Studio is on the user desktop (PID 43).",
		});
	});

	it("explains when there is no session Studio to move", async () => {
		expect.assertions(1);

		await expect(
			runShowAsync(createCommandContext(), { config: {}, flags: {} }),
		).rejects.toMatchObject({
			code: "studio_not_open",
			message: "No session Studio is open.",
		});
	});

	it("explains unsupported platforms", async () => {
		expect.assertions(1);

		const { context } = await movingSessionAsync("linux");

		await expect(runShowAsync(context, { config: {}, flags: {} })).rejects.toMatchObject({
			code: "usage",
			message: "Showing and hiding Studio requires Windows or macOS.",
		});
	});

	it("explains malformed save deadlines", async () => {
		expect.assertions(1);

		await expect(
			runShowAsync(createCommandContext(), { config: {}, flags: { timeout: "0" } }),
		).rejects.toMatchObject({
			code: "usage",
			message: "--timeout must be a positive number of seconds.",
		});
	});

	it("explains a malformed move response", async () => {
		expect.assertions(1);

		const { context, session } = await movingSessionAsync();
		session.moveStudio = () => ({ pid: 43 });

		await expect(runShowAsync(context, { config: {}, flags: {} })).rejects.toMatchObject({
			code: "internal_error",
			message: "The session answered moveStudio with something else.",
		});
	});
});
