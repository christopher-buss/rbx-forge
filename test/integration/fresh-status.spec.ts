/**
 * The `freshStatus` request of the control channel against a real
 * supervisor, whose fake roblox-ts compiler watches one file
 * (`FIXTURE_COMPILER_WATCH`).
 */
import nodeFs, { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";

import { findSession } from "../../src/client/session.ts";
import type { IpcTarget } from "../../src/ipc/client.ts";
import { callSessionAsync } from "../../src/ipc/client.ts";
import type { SessionStatus } from "../../src/session/status.ts";
import { parseStatus } from "../../src/session/status.ts";
import type { SessionRequest } from "../../src/supervisor/channel.ts";
import { forgeFiles } from "../../src/supervisor/session-files.ts";
import { realTransport } from "../helpers/native-testing.ts";
import type { Project } from "./session-harness.ts";
import { launch, makeProjectAsync, waitForAsync } from "./session-harness.ts";

const WITH_COMPILER: SessionRequest = { compiler: true, config: {}, open: false };
const POLL_MS = 50;
const WAIT_MS = 20_000;

interface Watched {
	/**
	 * Ask for the status once the build is fresh, waiting up to `timeoutMs`.
	 */
	askAsync: (timeoutMs: number) => Promise<SessionStatus["services"]["compiler"] | undefined>;
	/** Replace the watched file's text. */
	edit: (text: string) => void;
	/** Wait until the plain status shows a compile that runs. */
	waitForBuildingAsync: () => Promise<void>;
}

/**
 * Start a session whose compiler watches `src/main.ts`, and reach its
 * control channel.
 *
 * @param variables - `FIXTURE_COMPILE_*` and other fixture variables.
 * @returns How to edit the file and ask the session.
 */
async function startWatchedAsync(variables: Record<string, string>): Promise<Watched> {
	const project: Project = await makeProjectAsync({ projectType: "rbxts" });
	const watched = path.join(project.project, "src", "main.ts");
	mkdirSync(path.dirname(watched), { recursive: true });
	writeFileSync(watched, "export {};\n");
	launch(project, WITH_COMPILER, { FIXTURE_COMPILER_WATCH: watched, ...variables });
	const session = await waitForAsync(() => findSession(nodeFs, forgeFiles(project.project)));
	const target: IpcTarget = { endpoint: session.identity.endpoint, token: session.token };
	const transport = realTransport();
	return {
		askAsync: async (timeoutMs) => {
			const answer = await callSessionAsync(transport, target, "freshStatus", {
				params: { timeoutMs },
				responseTimeoutMs: timeoutMs + 5000,
			});
			return parseStatus(answer)?.services.compiler;
		},
		edit: (text) => {
			writeFileSync(watched, text);
		},
		waitForBuildingAsync: async () => {
			const deadline = Date.now() + WAIT_MS;
			while (Date.now() < deadline) {
				const answer = await callSessionAsync(transport, target, "status");
				if (parseStatus(answer)?.services.compiler.building === true) {
					return;
				}

				await sleep(POLL_MS);
			}

			throw new Error("the compile never started");
		},
	};
}

describe("freshStatus", () => {
	it("should wait for the first build, then for the build of each edit", async () => {
		expect.assertions(2);

		const session = await startWatchedAsync({ FIXTURE_COMPILE_MS: "1000" });
		const first = await session.askAsync(20_000);
		session.edit("export const error = 1;\n");
		const second = await session.askAsync(20_000);

		expect(first).toMatchObject({ building: false, lastBuild: { errors: 0 } });
		expect(second).toMatchObject({ building: false, lastBuild: { errors: 1 } });
	});

	it("should fail with compile_timeout while a compile runs past the bound", async () => {
		expect.assertions(1);

		const session = await startWatchedAsync({ FIXTURE_COMPILE_MS: "60000" });
		await session.waitForBuildingAsync();

		await expect(session.askAsync(500)).rejects.toMatchObject({
			code: "compile_timeout",
			details: { building: true, timeoutMs: 500 },
		});
	});

	it("should fail with service_failed when the compiler exits during the wait", async () => {
		expect.assertions(1);

		const session = await startWatchedAsync({
			FIXTURE_COMPILE_MS: "60000",
			FIXTURE_EXIT_AFTER_MS: "1500",
			FIXTURE_EXIT_ROLE: "rbxtsc",
		});

		await expect(session.askAsync(20_000)).rejects.toMatchObject({ code: "service_failed" });
	});
});
