import { assert, describe, it } from "vitest";

import { createFakeNative } from "../../test/helpers/native.ts";
import {
	createCommandContext,
	createMemoryFileSystem,
	createTestSeams,
	PROJECT,
} from "../../test/helpers/seams.ts";
import type { DownOptions } from "../client/down.ts";
import { stopSessionAsync } from "../client/down.ts";
import { findSession } from "../client/session.ts";
import { forgeFiles } from "../supervisor/session-files.ts";
import { runCompileCommandAsync } from "./compile.ts";
import { runDownAsync } from "./down.ts";
import { runHideAsync } from "./hide.ts";
import { runRestartAsync } from "./restart.ts";
import { runSaveAsync } from "./save.ts";
import { runShowAsync } from "./show.ts";
import { runStartAsync } from "./start.ts";
import { runStatusAsync } from "./status.ts";
import { runStopAsync } from "./stop.ts";
import { runSyncAsync } from "./sync.ts";
import { runUpAsync } from "./up.ts";

describe("foreign side sessions", () => {
	it.for([
		["win32", undefined, "wsl:Ubuntu"],
		["linux", "Ubuntu", "windows"],
		["linux", "Ubuntu", "wsl:Debian"],
	] as const)(
		"refuses status and forced down from %s",
		async ([platform, wslDistro, side], { expect }) => {
			expect.assertions(14);

			const memory = createMemoryFileSystem({
				".forge/current": "s1",
				".forge/sessions/s1/supervisor.id": JSON.stringify({
					endpoint: "e",
					pid: 1,
					processStartTime: "1",
					sessionId: "s1",
					side,
					startedAt: "t",
					version: "v",
				}),
				".forge/sessions/s1/token": "t",
			});
			const seams = createTestSeams({
				configLoader: async () => {
					return {
						path: "/project/forge.config.ts",
						value: { projectType: "rbxts" },
					};
				},
				fileSystem: memory.fileSystem,
			});
			Object.assign(seams.host, { platform, wslDistro });
			const context = createCommandContext({ seams });
			const before = memory.files();

			await expect(runStatusAsync(context)).rejects.toHaveProperty(
				"hint",
				`Run "forge down" on ${side}, then try again here.`,
			);
			await expect(runStatusAsync(context)).rejects.toHaveProperty(
				"message",
				`This session belongs to ${side}.`,
			);
			await expect(runStatusAsync(context)).rejects.toMatchObject({
				code: "identity_mismatch",
			});
			await expect(
				runDownAsync(context, { config: {}, flags: { force: true } }),
			).rejects.toMatchObject({ code: "identity_mismatch" });

			for (const command of [
				runUpAsync,
				runStartAsync,
				runStopAsync,
				runRestartAsync,
				runSaveAsync,
				runHideAsync,
				runShowAsync,
				runSyncAsync,
				runCompileCommandAsync,
			]) {
				await expect(
					command(context, { config: {}, flags: { force: true } }),
				).rejects.toMatchObject({ code: "identity_mismatch" });
			}

			expect(memory.files()).toStrictEqual(before);
		},
	);
});

function ownSession(platform: "linux" | "win32" = "linux") {
	const identity = JSON.stringify({
		endpoint: "e",
		pid: 1,
		processStartTime: "1",
		sessionId: "s1",
		side: platform === "win32" ? "windows" : "linux",
		startedAt: "t",
		version: "v",
	});
	const memory = createMemoryFileSystem({
		".forge/current": "s1",
		".forge/sessions/s1/supervisor.id": identity,
		".forge/sessions/s1/token": "t",
	});
	const native = createFakeNative();
	const seams = createTestSeams({ fileSystem: memory.fileSystem, native: () => native.addon });
	Object.assign(seams.host, { platform });
	const forge = forgeFiles(PROJECT);
	const session = findSession(seams.fileSystem, forge, seams.host);
	assert(session !== undefined);
	return { forge, identity, memory, native, seams, session };
}

const DOWN = {
	force: true,
	keepStudio: true,
	recovery: "keep",
	timeoutMs: 0,
} satisfies DownOptions;

describe("side record retention", () => {
	it.for([
		["barrier", "win32", "wsl:Ubuntu"],
		["barrier", "linux", "windows"],
		["delete", "win32", "wsl:Ubuntu"],
		["delete", "linux", "windows"],
	] as const)("rechecks the record before %s", async ([point, platform, side], { expect }) => {
		expect.assertions(2);

		const { forge, memory, seams, session } = ownSession(platform);
		const foreign = JSON.stringify({ side });

		await expect(
			stopSessionAsync(seams, forge, session, {
				...DOWN,
				pause: async (at) => {
					const write = {
						barrier: () => {},
						delete: () => {},
						[point]: () => {
							memory.fileSystem.writeFileSync(session.files.identity, foreign);
						},
					};
					write[at]();
				},
			}),
		).rejects.toHaveProperty("code", "identity_mismatch");
		expect(memory.files()[".forge/sessions/s1/supervisor.id"]).toBe(foreign);
	});

	it("refuses a foreign identity snapshot even if its files now name this side", async ({
		expect,
	}) => {
		expect.assertions(2);

		const { forge, identity, memory, seams, session } = ownSession();

		await expect(
			stopSessionAsync(
				seams,
				forge,
				{ ...session, identity: { ...session.identity, side: "windows" } },
				DOWN,
			),
		).rejects.toHaveProperty("code", "identity_mismatch");
		expect(memory.files()[".forge/sessions/s1/supervisor.id"]).toBe(identity);
	});

	it("rereads the side before trying to stop a live supervisor", async ({ expect }) => {
		expect.assertions(2);

		const { forge, memory, native, seams, session } = ownSession();
		native.processes.set(1, { alive: true, executablePath: "/node", startTime: "1" });
		let now = 0;
		seams.clock = {
			now: () => now,
			sleep: async (ms) => {
				now += ms;
			},
		};
		memory.fileSystem.writeFileSync(
			session.files.identity,
			JSON.stringify({ side: "windows" }),
		);

		await expect(stopSessionAsync(seams, forge, session, DOWN)).rejects.toHaveProperty(
			"code",
			"identity_mismatch",
		);
		expect(native.processes.get(1)).toHaveProperty("alive", true);
	});

	it("refuses a side replaced before forced cleanup and leaves its workers alive", async ({
		expect,
	}) => {
		expect.assertions(2);

		const { forge, memory, native, seams, session } = ownSession();
		native.sessions.set("s1", [{ pid: 77 }]);
		native.addon.isLockFree = () => {
			memory.fileSystem.writeFileSync(
				session.files.identity,
				JSON.stringify({ side: "windows" }),
			);
			return false;
		};

		await expect(stopSessionAsync(seams, forge, session, DOWN)).rejects.toHaveProperty(
			"code",
			"identity_mismatch",
		);
		expect(native.sessions.get("s1")).toStrictEqual([{ pid: 77 }]);
	});

	it("keeps its side until its own workers are proved gone", async ({ expect }) => {
		expect.assertions(4);

		const { forge, identity, memory, native, seams, session } = ownSession();
		const lease = native.addon.tryLockFile(session.files.lease, "shared");
		assert(lease !== null);

		await expect(
			stopSessionAsync(seams, forge, session, { ...DOWN, force: false }),
		).rejects.toHaveProperty("code", "cleanup_in_progress");
		expect(memory.files()[".forge/sessions/s1/supervisor.id"]).toBe(identity);

		lease.release();

		await expect(stopSessionAsync(seams, forge, session, DOWN)).resolves.toHaveProperty(
			"removed",
			true,
		);
		expect(memory.files()[".forge/sessions/s1/supervisor.id"]).toBeUndefined();
	});
});
