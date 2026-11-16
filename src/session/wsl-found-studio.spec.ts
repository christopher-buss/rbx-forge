import path from "node:path";
import { assert, describe, it } from "vitest";

import { makeStatus } from "../../test/helpers/fake-session.ts";
import {
	createCommandContext,
	createMemoryFileSystem,
	createTestSeams,
	PROJECT,
} from "../../test/helpers/seams.ts";
import { createFakeStudioHost } from "../../test/helpers/studio-host.ts";
import { DEFAULT_CONFIG } from "../config/resolve.ts";
import type { HelperClient } from "../native/helper-client.ts";
import { createWslStudioHost } from "../seams/wsl-studio-host.ts";
import { attachStudioAsync } from "./attach.ts";
import { createPartRestarter } from "./part-restarts.ts";
import { createPartStopper } from "./part-stops.ts";

const PLACE = path.join(PROJECT, "game.rbxl");
const START = "134116992000000000";

function world(lockHost = "WINDOWS", startTime = START) {
	const memory = createMemoryFileSystem({
		"game.rbxl.lock": `1000007\nRobloxStudioBeta\n${lockHost}\n`,
	});
	memory.setModifiedTime("game.rbxl.lock", 1767225600000);
	const seams = createTestSeams();
	const windows = createFakeStudioHost(
		{ ...seams, host: { ...seams.host, hostname: "windows", platform: "win32" } },
		{
			1000007: {
				alive: true,
				executablePath: String.raw`D:\temp\agents\RobloxStudioBeta.exe`,
				startTime,
			},
		},
	);
	const context = createCommandContext({
		env: { WSL_DISTRO_NAME: "fixture" },
		seams: { ...seams, fileSystem: memory.fileSystem, studioHost: windows.studioHost },
	});
	return { context, windows };
}

describe("wsl found Studio", () => {
	it.for([
		{ pid: 1000008, startTime: START },
		{ pid: 1000007, startTime: "134116991999990000" },
	])("rejects a helper pin for another identity %j", async (identity, { expect }) => {
		expect.assertions(1);

		const { context } = world();
		const replies = new Map<string, unknown>([
			["executablePath", String.raw`D:\temp\agents\RobloxStudioBeta.exe`],
			["pin", { ...identity, pin: "held" }],
			["processStartTime", START],
			["windowVisibility", "user"],
		]);
		const client: HelperClient = {
			identity: Promise.resolve({
				helperArch: "x64",
				hostname: "windows",
				protocol: 1,
				windowsArch: "x64",
			}),
			requestAsync: async (request) => replies.get(String(request["op"])),
		};
		context.seams.studioHost = createWslStudioHost(
			{ ...context.seams, cwd: context.cwd, environment: context.env },
			() => client,
		);

		expect(await attachStudioAsync(context, DEFAULT_CONFIG)).toBeUndefined();
	});

	it("attaches the Windows identity without reaching Linux process control", async ({
		expect,
	}) => {
		expect.assertions(1);

		const { context } = world();

		expect(await attachStudioAsync(context, DEFAULT_CONFIG)).toStrictEqual({
			origin: "found",
			place: PLACE,
			studio: { desktop: "user", pid: 1000007, startTime: START },
		});
	});

	it.for([
		["another-machine", START],
		["WINDOWS", "134116992100000000"],
	])("does not attach an unverified lock %s", async ([host, start], { expect }) => {
		expect.assertions(1);

		const { context } = world(host, start);

		expect(await attachStudioAsync(context, DEFAULT_CONFIG)).toBeUndefined();
	});

	it.for(["stop", "restart"] as const)(
		"keeps Found Studio rules for %s and closes through Windows with force",
		async (scope, { expect }) => {
			expect.assertions(5);

			const { context, windows } = world();
			const attached = await attachStudioAsync(context, DEFAULT_CONFIG);
			assert(attached !== undefined);
			const status = makeStatus();
			status.services.studio = {
				...attached.studio,
				origin: attached.origin,
				owner: null,
				place: PLACE,
				status: "open",
			};
			status.services.compiler.status = "off";
			status.services.rojo = { owner: null, status: "ready" };
			const running = new Set(["rojo"]);
			const stop = createPartStopper(
				{
					config: DEFAULT_CONFIG,
					context,
					status: {
						phase: () => {},
						snapshot: () => status,
						studio: () => {},
						studioLeft: () => {},
					},
				},
				{ end: () => {} },
				{
					flushSyncbackAsync: async () => {},
					ownership: { isOwned: false },
					parts: {
						isRunning: (part) => running.has(part),
						stopAsync: async (part) => {
							running.delete(part);
						},
					},
					state: { isAttached: true },
				},
			);
			const restart = createPartRestarter(
				{ status: { snapshot: () => status } },
				{
					add: async ({ parts }) => [...parts],
					parts: { hasSurvivors: () => false },
					stop,
				},
			);
			const actions = {
				restart,
				stop: async ({ force }: { force: boolean }) => {
					return stop({ force, keepStudio: false, scope: "stop" });
				},
			};
			const kept = await actions[scope]({ force: false });

			expect(kept.foundStudio).toBe(true);
			expect(windows.processes.get(1000007)!.alive).toBe(true);

			const forced = await actions[scope]({ force: true });

			expect(forced.stopped).toContain("studio");
			expect(windows.processes.get(1000007)!.alive).toBe(false);
			expect(context.seams.fileSystem.existsSync(`${PLACE}.lock`)).toBe(false);
		},
	);
});
