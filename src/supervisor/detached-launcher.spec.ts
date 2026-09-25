import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createFailingSpawner, createFakeSpawner } from "../../test/helpers/fake-process.ts";
import { createFakeNative } from "../../test/helpers/native.ts";
import { createMemoryFileSystem, PROJECT } from "../../test/helpers/seams.ts";
import type { DetachedSpawn } from "../native/addon.ts";
import type { SessionRequest } from "./channel.ts";
import type { DetachedBackend } from "./detached-launcher.ts";
import { createDetachedLauncher } from "./detached-launcher.ts";

const ENTRY = "/forge/dist/supervisor.mjs";
const REQUEST: SessionRequest = {
	compiler: true,
	config: {},
	detached: { report: "/project/.forge/launch/l1.ndjson" },
	open: false,
};
const LOG = path.join(PROJECT, ".forge", "logs", "supervisor.log");

function backendFor(
	platform: NodeJS.Platform,
	spawnDetached?: (spawn: DetachedSpawn) => null | number,
): DetachedBackend & { spawner: ReturnType<typeof createFakeSpawner> } {
	const spawner = createFakeSpawner();
	return {
		childProcess: spawner.runner,
		fileSystem: createMemoryFileSystem().fileSystem,
		host: { execPath: "/node", platform },
		native: () => {
			return {
				...createFakeNative().addon,
				...(spawnDetached === undefined ? {} : { spawnDetached }),
			};
		},
		spawner,
	};
}

describe(createDetachedLauncher, () => {
	it("should start the entry in a new session with its output in the supervisor log", () => {
		expect.assertions(4);

		const backend = backendFor("linux");
		const pid = createDetachedLauncher(
			backend,
			ENTRY,
		)({
			cwd: PROJECT,
			env: { PATH: "/bin", UNSET: undefined },
			request: REQUEST,
		});
		const [call] = backend.spawner.calls;

		expect(pid).toBe(1000);
		expect(call).toMatchObject({
			args: [ENTRY, JSON.stringify(REQUEST)],
			file: "/node",
			options: {
				cwd: PROJECT,
				detached: true,
				env: { PATH: "/bin", UV_THREADPOOL_SIZE: "16" },
				windowsHide: true,
			},
		});
		expect(call!.options["stdio"]).toStrictEqual([
			"ignore",
			expect.any(Number),
			expect.any(Number),
		]);
		expect(backend.spawner.children[0]!.referenced).toBeFalse();
	});

	it("should keep a thread pool size the caller set", () => {
		expect.assertions(1);

		const backend = backendFor("darwin");
		createDetachedLauncher(
			backend,
			ENTRY,
		)({
			cwd: PROJECT,
			env: { UV_THREADPOOL_SIZE: "4" },
			request: REQUEST,
		});

		expect(backend.spawner.calls[0]!.options["env"]).toStrictEqual({ UV_THREADPOOL_SIZE: "4" });
	});

	it("should report a supervisor that did not start", () => {
		expect.assertions(1);

		const backend = { ...backendFor("linux"), childProcess: createFailingSpawner("ENOENT") };

		expect(() => {
			createDetachedLauncher(backend, ENTRY)({ cwd: PROJECT, env: {}, request: REQUEST });
		}).toThrow(expect.objectContaining({ code: "internal_error" }));
	});

	it("should start it through the addon with breakaway on Windows", () => {
		expect.assertions(2);

		const spawnDetached = vi.fn<(spawn: DetachedSpawn) => null | number>().mockReturnValue(77);
		const backend = backendFor("win32", spawnDetached);
		const pid = createDetachedLauncher(
			backend,
			ENTRY,
		)({
			cwd: PROJECT,
			env: { PATH: "C:\\bin" },
			request: REQUEST,
		});

		expect(pid).toBe(77);
		expect(spawnDetached).toHaveBeenCalledExactlyOnceWith({
			args: [ENTRY, JSON.stringify(REQUEST)],
			cwd: PROJECT,
			env: { PATH: "C:\\bin", UV_THREADPOOL_SIZE: "16" },
			output: LOG,
			program: "/node",
		});
	});

	it("should refuse with detach_unsupported when the job forbids breakaway", () => {
		expect.assertions(1);

		const backend = backendFor("win32", () => null);

		expect(() => {
			createDetachedLauncher(backend, ENTRY)({ cwd: PROJECT, env: {}, request: REQUEST });
		}).toThrow(expect.objectContaining({ code: "detach_unsupported" }));
	});
});
