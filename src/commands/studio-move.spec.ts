import { fromAny } from "@total-typescript/shoehorn";

import { describe, expect, it, vi } from "vitest";

import { createMemoryTransport } from "../../test/helpers/fake-ipc.ts";
import { serveFakeSessionAsync } from "../../test/helpers/fake-session.ts";
import {
	createCommandContext,
	createMemoryFileSystem,
	createTestSeams,
} from "../../test/helpers/seams.ts";
import { ForgeError } from "../errors.ts";
import type { IpcHandler } from "../ipc/server.ts";
import { runHideAsync } from "./hide.ts";
import { runShowAsync } from "./show.ts";

const SAVE = {
	bytes: 500,
	desktop: "hidden",
	durationMs: 100,
	mtime: "2026-01-01T00:00:00Z",
	pid: 42,
	place: "/project/game.rbxl",
};

async function commandSessionAsync(platform: NodeJS.Platform = "win32") {
	const memory = createMemoryFileSystem();
	const ipc = createMemoryTransport();
	const handlers = await serveFakeSessionAsync(memory, ipc);
	const move = vi
		.fn<IpcHandler>()
		.mockResolvedValue({ durationMs: 1000, from: "hidden", pid: 43, save: SAVE, to: "user" });
	handlers.moveStudio = move;
	const context = createCommandContext({
		seams: createTestSeams({
			fileSystem: memory.fileSystem,
			host: { ...createTestSeams().host, platform },
			ipc,
		}),
	});
	return { context, move };
}

describe("session Studio moves", () => {
	it.for([runShowAsync, runHideAsync])(
		"should report studio_not_open when no session runs",
		async (run) => {
			expect.assertions(1);

			await expect(
				run(createCommandContext(), { config: {}, flags: {} }),
			).rejects.toMatchObject({ code: "studio_not_open" });
		},
	);

	it("should show the actual fallback desktop and save metadata", async () => {
		expect.assertions(2);

		const { context, move } = await commandSessionAsync();

		await expect(
			runHideAsync(context, {
				config: {},
				flags: { "studio-path": "Studio.exe", "timeout": "3" },
			}),
		).resolves.toMatchObject({
			data: { durationMs: 1000, from: "hidden", pid: 43, save: SAVE, to: "user" },
		});
		expect(move).toHaveBeenCalledWith(
			expect.objectContaining({
				desktop: "hidden",
				studioPath: fromAny(expect.stringContaining("Studio.exe")),
				timeoutMs: 3000,
			}),
		);
	});

	it("should request the user desktop with the default save timeout", async () => {
		expect.assertions(1);

		const { context, move } = await commandSessionAsync();
		await runShowAsync(context, { config: {}, flags: {} });

		expect(move).toHaveBeenCalledWith(
			expect.objectContaining({ desktop: "user", timeoutMs: 30_000 }),
		);
	});

	it("should preserve the save error reported by the session", async () => {
		expect.assertions(1);

		const { context, move } = await commandSessionAsync();
		move.mockRejectedValue(new ForgeError("studio_busy", "A modal blocks the save."));

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

	it.for(["0", "-1", "NaN", "Infinity"])(
		"should reject the invalid timeout %s",
		async (timeout) => {
			expect.assertions(1);

			await expect(
				runShowAsync(createCommandContext(), { config: {}, flags: { timeout } }),
			).rejects.toMatchObject({ code: "usage" });
		},
	);

	it("should reject moving between desktops on another platform", async () => {
		expect.assertions(1);

		const { context } = await commandSessionAsync("linux");

		await expect(runShowAsync(context, { config: {}, flags: {} })).rejects.toMatchObject({
			code: "usage",
		});
	});
});
