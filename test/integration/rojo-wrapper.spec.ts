import { decode } from "@msgpack/msgpack";

import { spawn, spawnSync } from "node:child_process";
import nodeFs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { assert, describe, expect, it, onTestFinished } from "vitest";

import { resolveConfig } from "../../src/config/resolve.ts";
import { writeRojoWrapper } from "../../src/rojo/wrapper-project.ts";
import { nodeNetwork } from "../../src/seams/network.ts";
import { endpointKey } from "../../src/supervisor/endpoint.ts";
import { createCommandContext, createTestSeams } from "../helpers/seams.ts";
import { makeTemporaryDirectory } from "../helpers/temporary-directory.ts";

const HAS_ROJO = spawnSync("rojo", ["--version"], { windowsHide: true }).status === 0;

async function readApiAsync(port: number, route: string): Promise<Record<string, unknown>> {
	const response = await fetch(`http://127.0.0.1:${port}/api/${route}`);
	assert(response.ok);
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Rojo's API responses are maps
	return decode(new Uint8Array(await response.arrayBuffer())) as Record<string, unknown>;
}

describe.skipIf(!HAS_ROJO)("real Rojo wrapper", () => {
	it("should preserve the root serve fields and tree while advertising the worktree name", async () => {
		expect.assertions(3);

		const port = await nodeNetwork.freePortAsync();
		const cwd = makeTemporaryDirectory({
			"default.project.json": JSON.stringify({
				name: "Wrapper test",
				gameId: 1011,
				placeId: 789,
				serveAddress: "127.0.0.1",
				servePlaceIds: [123, 456],
				servePort: port,
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$className: "ReplicatedStorage",
						Content: { $className: "Folder" },
					},
				},
			}),
		});
		const directory = path.join(cwd, "session");
		nodeFs.mkdirSync(directory);
		const context = createCommandContext({
			cwd,
			seams: createTestSeams({ fileSystem: nodeFs }),
		});
		writeRojoWrapper(context, resolveConfig({ projectType: "luau" }, {}), directory);
		const rojo = spawn("rojo", ["serve", path.join(directory, "rojo.project.json")], {
			cwd,
			stdio: "ignore",
			windowsHide: true,
		});
		const closed = new Promise<void>((resolve) => {
			rojo.once("close", () => {
				resolve();
			});
		});
		onTestFinished(async () => {
			rojo.kill();
			await closed;
		});
		const deadline = Date.now() + 10_000;
		while (!(await nodeNetwork.isListeningAsync(port))) {
			assert(
				rojo.exitCode === null && Date.now() < deadline,
				"Rojo did not listen on the copied serve port",
			);
			await sleep(50);
		}

		const info = await readApiAsync(port, "rojo");

		expect(info).toMatchObject({
			expectedPlaceIds: [123, 456],
			gameId: 1011,
			placeId: 789,
			projectName: `Wrapper test@${endpointKey(cwd, "game.rbxl")}`,
		});

		const tree = await readApiAsync(port, `read/${String(info["rootInstanceId"])}`);
		assert(typeof tree["instances"] === "object" && tree["instances"] !== null);
		const instances = Object.values(tree["instances"]);

		expect(instances).toHaveLength(3);
		expect(instances).toIncludeSameMembers([
			expect.objectContaining({
				ClassName: "DataModel",
				Name: `Wrapper test@${endpointKey(cwd, "game.rbxl")}`,
			}),
			expect.objectContaining({ ClassName: "ReplicatedStorage", Name: "ReplicatedStorage" }),
			expect.objectContaining({ ClassName: "Folder", Name: "Content" }),
		]);
	});
});
