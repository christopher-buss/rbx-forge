import { mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { assert, describe, it } from "vitest";

import { callSessionAsync } from "../../src/ipc/client.ts";
import { parseStatus } from "../../src/session/status.ts";
import { captureRojo } from "../helpers/capture-fixture.ts";
import { installCaptureRojoProxy } from "../helpers/capture-rojo-proxy.ts";
import { realTransport } from "../helpers/native-testing.ts";
import {
	launch,
	makeProjectAsync,
	START_STUDIO,
	studioEnvironment,
	waitForReadyAsync,
} from "./session-harness.ts";
import { waitForSessionAsync } from "./session-reach.ts";

function studioPluginsDirectory(home: string): string {
	return process.platform === "win32"
		? path.join(home, "AppData", "Local", "Roblox", "Plugins")
		: path.join(home, "Documents", "Roblox", "Plugins");
}

describe("the capture fixture's Rojo proxy", () => {
	it("disconnects the owned genuine Rojo transport while its forge session remains running", async ({
		expect,
	}) => {
		expect.assertions(3);

		const project = await makeProjectAsync({
			open: { buildFirst: true },
			rojoAlias: "forge-capture-rojo",
		});
		const proxy = installCaptureRojoProxy(project.project, captureRojo());
		const environment = studioEnvironment(project);
		// Genuine `rojo plugin install` fails without Studio's Plugins folder.
		mkdirSync(studioPluginsDirectory(environment["USERPROFILE"]!), { recursive: true });
		const run = launch(project, START_STUDIO, environment);
		await waitForReadyAsync(run);
		const session = await waitForSessionAsync(project);
		const target = { endpoint: session.identity.endpoint, token: session.token };
		const transport = realTransport();
		const status = parseStatus(await callSessionAsync(transport, target, "status"));
		assert(status !== undefined);
		const { port } = status.services.rojo;
		assert(port !== undefined);
		const url = `http://127.0.0.1:${port}/api/rojo`;
		const before = await fetch(url);

		expect(before.status).toBe(200);

		await before.arrayBuffer();
		proxy.disconnect();

		await expect(fetch(url)).rejects.toThrow("fetch failed");
		expect(await callSessionAsync(transport, target, "status")).toMatchObject({
			running: true,
			services: { rojo: { status: "ready" } },
		});
	});
});
