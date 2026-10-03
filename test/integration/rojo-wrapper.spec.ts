import { decode } from "@msgpack/msgpack";

import { spawn, spawnSync } from "node:child_process";
import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { assert, describe, expect, it, onTestFinished, vi } from "vitest";

import { resolveConfig } from "../../src/config/resolve.ts";
import { writeRojoWrapper } from "../../src/rojo/wrapper-project.ts";
import { nodeFileSystem } from "../../src/seams/file-system.ts";
import { nodeNetwork } from "../../src/seams/network.ts";
import { startRojoAsync } from "../../src/session/rojo-part.ts";
import type { StatusRecorder } from "../../src/session/status.ts";
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
	it("should watch a directory reached through the operating system's temporary path", () => {
		expect.assertions(2);

		const directory = makeTemporaryDirectory();
		const alias = path.join(os.tmpdir(), path.basename(directory));
		const moduleUrl = pathToFileURL(
			path.resolve(import.meta.dirname, "../../src/seams/file-system.ts"),
		).href;
		const source = `import { nodeFileSystem as fs } from ${JSON.stringify(moduleUrl)};
const directory = ${JSON.stringify(alias)};
const watch = fs.watch(directory);
watch.once('change', (_event, name) => { console.log(name); watch.close(); });
fs.writeFileSync(directory + '/watched.txt', 'content');`;
		const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
			encoding: "utf8",
			timeout: 5000,
			windowsHide: true,
		});

		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe("watched.txt");
	});

	it("should reload replaced project files without changing the Rojo session or root serve fields", async () => {
		expect.assertions(4);

		const port = await nodeNetwork.freePortAsync();
		const project = {
			name: "Reload test",
			servePlaceIds: [123],
			tree: {
				$className: "DataModel",
				ReplicatedStorage: {
					$className: "ReplicatedStorage",
					Original: { $className: "Folder" },
				},
			},
		};
		const cwd = makeTemporaryDirectory({ "default.project.json": JSON.stringify(project) });
		const directory = path.join(cwd, "session");
		nodeFs.mkdirSync(directory);
		const context = createCommandContext({
			cwd,
			seams: createTestSeams({ fileSystem: nodeFileSystem }),
		});
		const abort = new AbortController();
		const tracked: Array<Promise<unknown>> = [];
		const scope = {
			signal: abort.signal,
			track: (task: Promise<unknown>) => {
				tracked.push(task);
			},
		};
		const stopped = Promise.withResolvers<void>();
		let rojo: ReturnType<typeof spawn>;
		await startRojoAsync(
			{
				config: resolveConfig({ projectType: "luau" }, {}),
				context,
				directory,
				resolveRojo: () => {
					throw new Error("unused");
				},
				rojoPort: { chooseAsync: async () => port },
				status: {
					rojoPort: vi.fn<StatusRecorder["rojoPort"]>(),
					service: vi.fn<StatusRecorder["service"]>(),
				},
			},
			scope,
			{
				startAsync: async ({ args }) => {
					rojo = spawn("rojo", args, { cwd, stdio: "ignore", windowsHide: true });
					rojo.once("close", stopped.resolve);
					return { stopped: stopped.promise };
				},
			},
			{
				port,
				service: {
					id: "rojo",
					args: [
						"serve",
						path.join(directory, "rojo.project.json"),
						"--port",
						String(port),
					],
					file: "rojo",
					step: "rojo serve",
				},
			},
		);
		onTestFinished(async () => {
			abort.abort();
			rojo.kill();
			await stopped.promise;
			await Promise.all(tracked);
		});
		const deadline = Date.now() + 10_000;
		while (!(await nodeNetwork.isListeningAsync(port))) {
			assert(rojo!.exitCode === null && Date.now() < deadline, "Rojo did not listen");
			await sleep(50);
		}

		const before = await readApiAsync(port, "rojo");
		const wrapper = nodeFs.readFileSync(path.join(directory, "rojo.project.json"), "utf8");
		nodeFs.writeFileSync(
			path.join(cwd, "replacement.json"),
			JSON.stringify({
				...project,
				name: "Renamed",
				servePlaceIds: [999],
				tree: {
					$className: "DataModel",
					ReplicatedStorage: {
						$className: "ReplicatedStorage",
						Replacement: { $className: "Folder" },
					},
				},
			}),
		);
		nodeFs.renameSync(
			path.join(cwd, "replacement.json"),
			path.join(cwd, "default.project.json"),
		);
		let instances: Array<unknown> = [];
		let hasReplacement = false;
		while (!hasReplacement) {
			const tree = await readApiAsync(port, `read/${String(before["rootInstanceId"])}`);
			assert(typeof tree["instances"] === "object" && tree["instances"] !== null);
			instances = Object.values(tree["instances"]);
			hasReplacement = instances.some((instance) => {
				assert(typeof instance === "object" && instance !== null && "Name" in instance);
				return instance.Name === "Replacement";
			});
			assert(Date.now() < deadline, "Rojo did not reload the replaced project");
			await sleep(50);
		}

		const after = await readApiAsync(port, "rojo");

		expect(after["sessionId"]).toBe(before["sessionId"]);
		expect(after).toMatchObject({
			expectedPlaceIds: [123],
			projectName: `Reload test@${endpointKey(cwd, "game.rbxl")}`,
		});
		expect(instances).not.toContainEqual(expect.objectContaining({ Name: "Original" }));
		expect(nodeFs.readFileSync(path.join(directory, "rojo.project.json"), "utf8")).toBe(
			wrapper,
		);
	});

	it.for([
		{ name: path.basename, projectPath: "default.project.json" },
		{ name: path.basename, projectPath: "default.project.jsonc" },
		{ name: () => "named", projectPath: "named.project.json" },
		{ name: () => "my.game", projectPath: "my.game.project.jsonc" },
	])(
		"should preserve JSONC root fields and the unnamed $projectPath tree",
		async ({ name, projectPath }) => {
			expect.assertions(5);

			const port = await nodeNetwork.freePortAsync();
			const cwd = makeTemporaryDirectory({
				[projectPath]: `/* Rojo accepts JSONC */\n${JSON.stringify({
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
				}).replace(/}$/, ", // trailing root comma\n}")}`,
			});
			const projectName = name(cwd);
			const directory = path.join(cwd, "session");
			nodeFs.mkdirSync(directory);
			const context = createCommandContext({
				cwd,
				seams: createTestSeams({ fileSystem: nodeFs }),
			});
			writeRojoWrapper(
				context,
				resolveConfig({ projectType: "luau", rojoProjectPath: projectPath }, {}),
				directory,
			);
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

			await expect(nodeNetwork.getRojoInfoAsync(port)).resolves.toMatchObject({
				projectName: `${projectName}@${endpointKey(cwd, "game.rbxl")}`,
				protocolVersion: 5,
				sessionId: info["sessionId"],
			});

			expect(info).toMatchObject({
				gameId: 1011,
				placeId: 789,
				projectName: `${projectName}@${endpointKey(cwd, "game.rbxl")}`,
			});
			expect(info["expectedPlaceIds"]).toIncludeSameMembers([123, 456]);

			const tree = await readApiAsync(port, `read/${String(info["rootInstanceId"])}`);
			assert(typeof tree["instances"] === "object" && tree["instances"] !== null);
			const instances = Object.values(tree["instances"]);

			expect(instances).toHaveLength(3);
			expect(instances).toIncludeSameMembers([
				expect.objectContaining({
					ClassName: "DataModel",
					Name: `${projectName}@${endpointKey(cwd, "game.rbxl")}`,
				}),
				expect.objectContaining({
					ClassName: "ReplicatedStorage",
					Name: "ReplicatedStorage",
				}),
				expect.objectContaining({ ClassName: "Folder", Name: "Content" }),
			]);
		},
	);
});
