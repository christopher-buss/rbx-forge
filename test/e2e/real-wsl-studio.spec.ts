// cspell:words drvfs wslinfo osrelease
import { type } from "arktype";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, statfsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { assert, describe, it } from "vitest";

import { parseOpened, parseResult } from "../helpers/output.ts";
import { ownedWslTerminalAsync } from "../helpers/owned-wsl-terminal.ts";
import { studioCleanup } from "../helpers/real-studio-cleanup.ts";
import { realStudioHost } from "../helpers/real-studio-host.ts";
import { installWindowsRojoAsync, windowsForgeAsync } from "../helpers/windows-forge.ts";
import {
	compatibilitySnapshotAsync,
	makeRealProjectAsync,
	realVariables,
	waitForLoadedAsync,
} from "./real-studio.spec.ts";
import { runBinAsync } from "./run-bin.ts";
import { runForgeAsync } from "./up-fixture.ts";
import type { UpRun } from "./up-fixture.ts";

const IS_ENABLED =
	process.env["RBX_FORGE_TEST_REAL_WSL_STUDIO"] === "1" && process.platform === "linux";
const FILESYSTEMS: Record<string, number> = { drvfs: 0x01021997, ext4: 0xef53 };
const EXPECTED_FILESYSTEM = FILESYSTEMS[process.env["RBX_FORGE_TEST_WSL_FILESYSTEM"] ?? ""];

function recordRun(command: string, run: UpRun): void {
	const log = process.env["RBX_FORGE_TEST_REAL_STUDIO_LOG"];
	assert(log !== undefined);
	appendFileSync(
		log,
		`${JSON.stringify({ command, result: run.result, stderr: run.stderr, stdout: run.stdout })}\n`,
	);
}

describe.skipIf(!IS_ENABLED)("packed WSL2 real Studio release checks", () => {
	it("records the actual kernel, networking mode and project file system", ({ expect }) => {
		expect.assertions(5);

		const kernel = readFileSync("/proc/sys/kernel/osrelease", "utf8").trim();
		const network = spawnSync("wslinfo", ["--networking-mode"], {
			encoding: "utf8",
			windowsHide: true,
		});
		const packed = process.env["RBX_FORGE_TEST_PACKED_INSTALL"];
		assert(packed !== undefined && path.isAbsolute(packed));

		expect(kernel).toMatch(/microsoft-standard-WSL2/iu);
		expect(network.status).toBe(0);
		expect(network.stdout.trim()).toBe(process.env["RBX_FORGE_TEST_WSL_NETWORK"]);

		const record = {
			fileSystem: statfsSync(os.tmpdir()).type,
			kernel,
			network: network.stdout.trim(),
			packed,
			temporaryDirectory: os.tmpdir(),
		};
		const log = process.env["RBX_FORGE_TEST_REAL_STUDIO_LOG"];
		assert(log !== undefined);
		writeFileSync(`${log}.environment.json`, JSON.stringify(record, null, 2));

		expect(record.fileSystem).toBe(EXPECTED_FILESYSTEM);

		expect(existsSync(path.join(packed, "bin/rbx-forge.js"))).toBeTrue();
	});

	it(
		"uses the untouched packed CLI to attach, refuse stop, restart, save and force-close an owned Studio",
		{ timeout: 240_000 },
		async ({ expect }) => {
			expect.assertions(7);

			const fixture = await makeRealProjectAsync("unsaved.rbxl");
			const own = studioCleanup(fixture.project);
			const launched = await realStudioHost().launchAsync({
				cwd: fixture.project,
				desktop: "user",
				env: {},
				place: fixture.place,
			});
			assert(launched.type === "launched" && launched.studio !== undefined);
			const pinned = await own(launched.studio);

			await expect
				.poll(() => existsSync(`${fixture.place}.lock`), { timeout: 90_000 })
				.toBeTrue();

			const packed = process.env["RBX_FORGE_TEST_PACKED_INSTALL"];
			assert(packed !== undefined);
			const untouched = { ...fixture, bin: path.join(packed, "bin/rbx-forge.js") };
			const up = await runForgeAsync(
				untouched,
				["up", "--studio", "--json"],
				realVariables(),
			);

			expect(up).toMatchObject({
				result: {
					data: {
						services: { studio: { origin: "found", os: "win32", pid: pinned.pid } },
					},
				},
				status: 0,
			});

			const stop = await runForgeAsync(untouched, ["stop", "--json"], realVariables());

			expect(stop.result).toMatchObject({ error: { code: "studio_found" }, ok: false });

			const restart = await runForgeAsync(untouched, ["restart", "--json"], realVariables());

			expect(restart.status).toBe(0);
			expect(await pinned.isAliveAsync()).toBeTrue();

			const save = await runForgeAsync(untouched, ["save", "--json"], realVariables());

			recordRun("untouched-save", save);

			expect(save.status).toBe(0);

			await runForgeAsync(untouched, ["stop", "--force", "--json"], realVariables());

			await expect.poll(async () => pinned.isAliveAsync(), { timeout: 10_000 }).toBeFalse();
		},
	);

	it(
		"keeps the same Studio controllable after closing its owned WSL launch terminal",
		{ timeout: 240_000 },
		async ({ expect }) => {
			expect.assertions(6);

			const fixture = await makeRealProjectAsync("unsaved.rbxl");
			const own = studioCleanup(fixture.project);
			const terminal = await ownedWslTerminalAsync({
				bin: fixture.cli.bin,
				project: fixture.project,
				variables: realVariables(),
			});
			const output = path.join(fixture.project, "owned-terminal-up.ndjson");

			await expect
				.poll(() => readFileSync(output, "utf8").includes('"type":"result"'), {
					timeout: 120_000,
				})
				.toBeTrue();

			const up = parseResult(readFileSync(output, "utf8"));
			assert(up.ok && up.data !== undefined, JSON.stringify(up));
			const loaded = await waitForLoadedAsync(fixture, String(up.data["sessionId"]));
			const pinned = loaded[2];
			await own({ pid: pinned.pid, startTime: pinned.startTime });
			await terminal.killAsync();

			expect(await terminal.waitForExitAsync(10_000)).toBeTrue();
			expect(await pinned.isAliveAsync()).toBeTrue();

			const shown = await runForgeAsync(fixture, ["show", "--json"], realVariables());

			expect(shown.status).toBe(0);
			await expect
				.poll(async () => pinned.windowVisibilityAsync(), { timeout: 15_000 })
				.toBe("user");

			const saved = await runForgeAsync(fixture, ["save", "--json"], realVariables());

			expect(saved.status).toBe(0);
		},
	);

	it(
		"keeps the snapshot Lighting watcher alive after closing its owned WSL launch terminal",
		{ timeout: 150_000 },
		async ({ expect }) => {
			expect.assertions(6);

			const fixture = await compatibilitySnapshotAsync();
			const own = studioCleanup();
			const terminal = await ownedWslTerminalAsync({
				argv: ["open", "--desktop", "hidden"],
				bin: fixture.cli.bin,
				project: fixture.project,
				variables: realVariables(),
			});
			const output = path.join(fixture.project, "owned-terminal-up.ndjson");

			await expect
				.poll(() => readFileSync(output, "utf8").includes('"type":"result"'), {
					timeout: 90_000,
				})
				.toBeTrue();

			const opened = parseResult(readFileSync(output, "utf8"));
			assert(opened.ok, JSON.stringify(opened));
			const { place, studio } = parseOpened(opened.data);
			assert(studio !== null);
			const pinned = await own(studio);

			await expect
				.poll(() => Number(readFileSync(`${place}.lock`, "utf8").split(/\r?\n/, 1)[0]), {
					timeout: 90_000,
				})
				.toBe(studio.pid);

			await terminal.killAsync();

			expect(await terminal.waitForExitAsync(10_000)).toBeTrue();

			await sleep(15_000);

			await expect
				.poll(async () => pinned.isBlockedAsync(), { interval: 500, timeout: 30_000 })
				.toBeFalse();

			const saved = await runForgeAsync(
				fixture,
				["save", "--place", place, "--json"],
				realVariables(),
			);
			recordRun("snapshot-after-relay-loss", saved);

			expect(saved).toMatchObject({ result: { ok: true }, status: 0 });
			expect(await pinned.isAliveAsync()).toBeTrue();
		},
	);

	it(
		"recovers a genuinely lost Windows helper save reply without repeating the menu save",
		{ timeout: 240_000 },
		async ({ expect }) => {
			expect.assertions(5);

			const fixture = await makeRealProjectAsync("unsaved.rbxl");
			const packed = process.env["RBX_FORGE_TEST_PACKED_INSTALL"];
			assert(packed !== undefined);
			const requireModule = createRequire(path.join(packed, "package.json"));
			const target = requireModule.resolve(
				`@rbx-forge/native-linux-${process.arch}-gnu/forge-windows-helper.exe`,
			);
			const log = path.join(fixture.project, "helper-requests.ndjson");
			const variables = {
				...realVariables(),
				RBX_FORGE_TEST_HELPER_PROXY_LOG: log,
				RBX_FORGE_TEST_HELPER_PROXY_TARGET: target,
				RBX_FORGE_TEST_WINDOWS_HELPER: path.join(
					import.meta.dirname,
					"../fixtures/bin/real-helper-loss-proxy.ts",
				),
			};
			const own = studioCleanup(fixture.project);
			const up = await runForgeAsync(fixture, ["up", "--studio", "--json"], variables);
			assert(up.status === 0 && up.result.data !== undefined, up.stdout);
			const sessionId = String(up.result.data["sessionId"]);
			const loaded = await waitForLoadedAsync(fixture, sessionId);
			const pinned = loaded[2];
			await own({ pid: pinned.pid, startTime: pinned.startTime });
			const before = readFileSync(fixture.place);
			const saved = await runForgeAsync(
				fixture,
				["save", "--timeout", "30", "--json"],
				variables,
			);

			recordRun("lost-reply-save", saved);

			expect(saved).toMatchObject({ result: { ok: true }, status: 0 });
			expect(existsSync(`${log}.lost`)).toBeTrue();
			expect(
				readFileSync(log, "utf8")
					.split("\n")
					.filter((line) => line.includes('"requestSave"')),
			).toHaveLength(1);
			expect(readFileSync(fixture.place).equals(before)).toBeFalse();
			expect(await pinned.isAliveAsync()).toBeTrue();
		},
	);

	it(
		"retains an unknown real launch without replay or foreign cleanup",
		{ timeout: 180_000 },
		async ({ expect }) => {
			expect.assertions(6);

			const fixture = await makeRealProjectAsync("unsaved.rbxl");
			const packed = process.env["RBX_FORGE_TEST_PACKED_INSTALL"];
			assert(packed !== undefined);
			const target = createRequire(path.join(packed, "package.json")).resolve(
				`@rbx-forge/native-linux-${process.arch}-gnu/forge-windows-helper.exe`,
			);
			const log = path.join(fixture.project, "lost-launch.ndjson");
			const variables = {
				...realVariables(),
				RBX_FORGE_TEST_HELPER_PROXY_LOG: log,
				RBX_FORGE_TEST_HELPER_PROXY_OPERATION: "launch",
				RBX_FORGE_TEST_HELPER_PROXY_TARGET: target,
				RBX_FORGE_TEST_WINDOWS_HELPER: path.join(
					import.meta.dirname,
					"../fixtures/bin/real-helper-loss-proxy.ts",
				),
			};
			const own = studioCleanup(fixture.project);
			const launched = await runForgeAsync(fixture, ["up", "--studio", "--json"], variables);
			recordRun("lost-launch", launched);
			const { result: identity } = type({
				result: { pid: "number.integer > 0", startTime: "string" },
			}).assert(JSON.parse(readFileSync(`${log}.lost`, "utf8")));
			const pin = await own(identity);

			expect(launched.result).toMatchObject({
				error: { code: "studio_launch_unknown" },
				ok: false,
			});
			expect(await pin.isAliveAsync()).toBeTrue();

			const current = path.join(fixture.project, ".forge/current");
			const before = readFileSync(current, "utf8");
			const down = await runForgeAsync(fixture, ["down", "--force", "--json"], variables);
			recordRun("lost-launch-down", down);

			expect(down.result).toMatchObject({
				error: { code: "cleanup_in_progress" },
				ok: false,
			});
			expect(readFileSync(current, "utf8")).toBe(before);
			expect(
				readFileSync(log, "utf8")
					.split("\n")
					.filter((line) => line.includes('"op":"launch"')),
			).toHaveLength(1);
			expect(await pin.isAliveAsync()).toBeTrue();
		},
	);

	it(
		"retains an uncertain real close without replay or kill",
		{ timeout: 180_000 },
		async ({ expect }) => {
			expect.assertions(5);

			const fixture = await makeRealProjectAsync("saved.rbxl");
			const packed = process.env["RBX_FORGE_TEST_PACKED_INSTALL"];
			assert(packed !== undefined);
			const target = createRequire(path.join(packed, "package.json")).resolve(
				`@rbx-forge/native-linux-${process.arch}-gnu/forge-windows-helper.exe`,
			);
			const log = path.join(fixture.project, "lost-close.ndjson");
			const variables = {
				...realVariables(),
				RBX_FORGE_TEST_HELPER_PROXY_LOG: log,
				RBX_FORGE_TEST_HELPER_PROXY_OPERATION: "requestClose",
				RBX_FORGE_TEST_HELPER_PROXY_TARGET: target,
				RBX_FORGE_TEST_WINDOWS_HELPER: path.join(
					import.meta.dirname,
					"../fixtures/bin/real-helper-loss-proxy.ts",
				),
			};
			const own = studioCleanup(fixture.project);
			const up = await runForgeAsync(fixture, ["up", "--studio", "--json"], variables);
			assert(up.status === 0 && up.result.data !== undefined, up.stdout);
			const pinLoaded = await waitForLoadedAsync(
				fixture,
				String(up.result.data["sessionId"]),
			);
			const pin = pinLoaded[2];
			await own({ pid: pin.pid, startTime: pin.startTime });
			const closed = await runForgeAsync(fixture, ["stop", "--force", "--json"], variables);
			recordRun("lost-close", closed);

			expect(existsSync(`${log}.lost`)).toBeTrue();
			expect(closed.result).toMatchObject({
				error: {
					code: "process_failed",
					message: "The Studio close result is unknown; Studio was not killed.",
				},
				ok: false,
			});
			expect(await pin.isAliveAsync()).toBeTrue();

			const requests = readFileSync(log, "utf8").split("\n");

			expect(requests.filter((line) => line.includes('"op":"requestClose"'))).toHaveLength(1);
			expect(requests.filter((line) => line.includes('"op":"kill"'))).toHaveLength(0);
		},
	);

	it.skipIf(
		process.env["RBX_FORGE_TEST_WSL_FILESYSTEM"] !== "drvfs" ||
			process.env["RBX_FORGE_TEST_WINDOWS_NATIVE_DIR"] === undefined,
	)(
		"excludes actual Windows and WSL sessions in both directions",
		{ timeout: 300_000 },
		async ({ expect, onTestFinished }) => {
			expect.assertions(31);

			const fixture = await makeRealProjectAsync("saved.rbxl");
			const commands = [
				["status"],
				["up", "--force"],
				["down", "--force"],
				["stop", "--force"],
				["stop", "--place", fixture.place, "--force"],
				["save"],
				["save", "--place", fixture.place],
			];

			const own = studioCleanup(fixture.project);
			async function linuxAsync(argv: ReadonlyArray<string>): Promise<UpRun> {
				const run = await runBinAsync(
					[...argv, "--json"],
					fixture.project,
					fixture.environment(realVariables()),
					{ bin: fixture.bin, registerCleanup: false },
				);
				return { ...run, result: parseResult(run.stdout) };
			}

			async function windowsAsync(argv: ReadonlyArray<string>): Promise<UpRun> {
				return windowsForgeAsync(fixture, [...argv, "--json"]);
			}

			onTestFinished(async () => {
				await windowsAsync(["down", "--force"]);
			});
			const up = await linuxAsync(["up", "--studio"]);
			assert(up.status === 0 && up.result.data !== undefined, up.stdout);
			const firstLoaded = await waitForLoadedAsync(
				fixture,
				String(up.result.data["sessionId"]),
			);
			const first = firstLoaded[2];
			await own({ pid: first.pid, startTime: first.startTime });
			const current = path.join(fixture.project, ".forge/current");
			const linuxIdentity = readFileSync(current, "utf8");
			for (const argv of commands) {
				const denied = await windowsAsync(argv);
				recordRun(`windows-foreign ${argv.join(" ")}`, denied);

				expect(denied.result).toMatchObject({
					error: { code: "identity_mismatch" },
					ok: false,
				});
				expect(readFileSync(current, "utf8")).toBe(linuxIdentity);
			}

			expect(await first.isAliveAsync()).toBeTrue();

			const linuxDown = await linuxAsync(["down", "--force"]);
			assert(linuxDown.status === 0);
			await installWindowsRojoAsync(fixture.project);
			const winUp = await windowsAsync(["up", "--studio", "--desktop", "hidden"]);
			recordRun("windows-owner-up", winUp);
			assert(winUp.status === 0 && winUp.result.data !== undefined, winUp.stdout);
			const {
				services: { studio },
			} = type({
				services: { studio: { pid: "number.integer > 0", startTime: "string" } },
			}).assert(winUp.result.data);
			const second = await own(studio);

			await expect
				.poll(
					() => {
						return Number(
							readFileSync(`${fixture.place}.lock`, "utf8").split(/\r?\n/, 1)[0],
						);
					},
					{ timeout: 90_000 },
				)
				.toBe(studio.pid);

			const windowsIdentity = readFileSync(current, "utf8");
			for (const argv of commands) {
				const denied = await linuxAsync(argv);
				recordRun(`wsl-foreign ${argv.join(" ")}`, denied);

				expect(denied.result).toMatchObject({
					error: { code: "identity_mismatch" },
					ok: false,
				});
				expect(readFileSync(current, "utf8")).toBe(windowsIdentity);
			}

			expect(await second.isAliveAsync()).toBeTrue();

			const windowsDown = await windowsAsync(["down", "--force"]);
			assert(windowsDown.status === 0);
		},
	);
});
