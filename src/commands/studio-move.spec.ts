import { describe, expect, it, onTestFinished, vi } from "vitest";

import { createMemoryTransport } from "../../test/helpers/fake-ipc.ts";
import { serveFakeSessionAsync } from "../../test/helpers/fake-session.ts";
import {
	createCommandContext,
	createMemoryFileSystem,
	createRecordingReporter,
	createTestSeams,
} from "../../test/helpers/seams.ts";
import { ForgeError } from "../errors.ts";
import type { IpcHandler } from "../ipc/server.ts";
import { runHideAsync } from "./hide.ts";
import { runShowAsync } from "./show.ts";

async function commandSessionAsync(platform: NodeJS.Platform = "win32") {
	const memory = createMemoryFileSystem();
	const ipc = createMemoryTransport();
	const handlers = await serveFakeSessionAsync(memory, ipc);
	const move = vi
		.fn<IpcHandler>()
		.mockResolvedValue({ durationMs: 1000, from: "hidden", pid: 43, to: "user" });
	handlers.moveStudio = move;
	const reporter = createRecordingReporter();
	const context = createCommandContext({
		reporter,
		seams: createTestSeams({
			fileSystem: memory.fileSystem,
			host: { ...createTestSeams().host, platform },
			ipc,
		}),
	});
	return { context, move, reporter };
}

describe("session Studio moves", () => {
	it("waits for a move queued behind a save taking longer than two seconds", async () => {
		expect.assertions(1);

		const { context, move } = await commandSessionAsync();
		vi.useFakeTimers();
		onTestFinished(() => {
			vi.useRealTimers();
		});
		move.mockImplementation(async () => {
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 3000);
			});
			return { durationMs: 0, from: "hidden", pid: 43, to: "user" };
		});
		const result = runShowAsync(context, { config: {}, flags: {} });
		await vi.advanceTimersByTimeAsync(3000);

		await expect(result).resolves.toMatchObject({
			data: { from: "hidden", pid: 43, to: "user" },
		});
	});

	it("should report a hidden macOS app without saving", async () => {
		expect.assertions(2);

		const { context, move, reporter } = await commandSessionAsync("darwin");
		move.mockResolvedValue({
			durationMs: 300,
			from: "user",
			pid: 42,
			to: "hidden",
		});

		await expect(runHideAsync(context, { config: {}, flags: {} })).resolves.toMatchObject({
			data: { from: "user", pid: 42, to: "hidden" },
			summary: "Studio is hidden (PID 42).",
		});
		expect(reporter.events).toStrictEqual([]);
	});

	it("should show a macOS app without warning about lost undo history", async () => {
		expect.assertions(2);

		const { context, move, reporter } = await commandSessionAsync("darwin");
		move.mockResolvedValue({
			durationMs: 300,
			from: "hidden",
			pid: 42,
			to: "user",
		});

		await expect(runShowAsync(context, { config: {}, flags: {} })).resolves.toMatchObject({
			data: { from: "hidden", pid: 42, to: "user" },
			summary: "Studio is shown (PID 42).",
		});
		expect(reporter.events).toStrictEqual([]);
	});

	it.for([runShowAsync, runHideAsync])(
		"should report studio_not_open when no session runs",
		async (run) => {
			expect.assertions(1);

			await expect(
				run(createCommandContext(), { config: {}, flags: {} }),
			).rejects.toMatchObject({ code: "studio_not_open" });
		},
	);

	it("requests only the target visibility and reports the unchanged PID", async () => {
		expect.assertions(2);

		const { context, move } = await commandSessionAsync();

		await expect(runShowAsync(context, { config: {}, flags: {} })).resolves.toMatchObject({
			data: { durationMs: 1000, from: "hidden", pid: 43, to: "user" },
		});
		expect(move.mock.calls[0]![0]).toMatchObject({
			desktop: "user",
			sessionId: "s1",
		});
	});

	it("should preserve the error reported by the session", async () => {
		expect.assertions(1);

		const { context, move } = await commandSessionAsync();
		move.mockRejectedValue(new ForgeError("studio_busy", "Visibility change failed."));

		await expect(runShowAsync(context, { config: {}, flags: {} })).rejects.toMatchObject({
			code: "studio_busy",
		});
	});

	it("should reject an invalid session move result", async () => {
		expect.assertions(1);

		const { context, move } = await commandSessionAsync();
		move.mockResolvedValue({ pid: 43 });

		await expect(runShowAsync(context, { config: {}, flags: {} })).rejects.toMatchObject({
			code: "internal_error",
		});
	});

	it("should reject moving between desktops on another platform", async () => {
		expect.assertions(1);

		const { context } = await commandSessionAsync("linux");

		await expect(runShowAsync(context, { config: {}, flags: {} })).rejects.toMatchObject({
			code: "usage",
		});
	});
});
