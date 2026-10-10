import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { assert, describe, expect, it, onTestFinished } from "vitest";

import { EXIT_FAILURE, EXIT_SUCCESS } from "../../src/exit-codes.ts";
import { withVariables } from "../../src/process/environment.ts";
import { studioPlaceContent } from "../fixtures/bin/studio-stand-in.ts";
import type { FixtureProject } from "../helpers/fixture-project.ts";
import { makeFixtureProject } from "../helpers/fixture-project.ts";
import { parseLines, parseOpened, parseResult } from "../helpers/output.ts";
import {
	loadRealNative,
	makeRunScriptStudioExecutable,
	NATIVE_DIRECTORY,
	waitForFileAsync,
} from "../helpers/real-native.ts";
import type { WorkerRecord } from "../helpers/worker-log.ts";
import { isProcessAlive, readWorkerLog } from "../helpers/worker-log.ts";
import { BIN } from "./run-bin.ts";
import { makeFixtureAsync, wrapperPath } from "./session-fixture.ts";
import { runForgeAsync, WATCH_COMMAND } from "./up-fixture.ts";

const FAKE_WORKER = path.join(import.meta.dirname, "..", "fixtures", "bin", "fake-worker.ts");
const FORBID_BREAKAWAY = path.join(
	import.meta.dirname,
	"..",
	"fixtures",
	"bin",
	"forbid-breakaway.ts",
);
const IS_WINDOWS = process.platform === "win32";
/** The fixture role that stands in for the POSIX platform launcher. */
const LAUNCHER = process.platform === "darwin" ? "open" : "xdg-open";

/** The place every test names, in a folder with a space. */
const PLACE = "My Places/game.rbxl";
/** A snapshot's file name: the time `forge open` built it, then the place's. */
const SNAPSHOT_NAME = /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}_game\.rbxl$/;

/**
 * The place's content: Node, started as Studio with the place, runs the
 * fixture Studio (`test/fixtures/bin/studio-stand-in.ts`).
 */
const PLACE_CONTENT = studioPlaceContent();

interface Fixture extends FixtureProject {
	/** The absolute path of {@link PLACE}. */
	place: string;
	/** The absolute path of `.forge/snapshots`. */
	snapshots: string;
}

/**
 * A project whose `forge` starts Node as Studio, directly, through the
 * native addon.
 *
 * @param files - Extra files, by path relative to the project.
 * @returns The project.
 */
function makeFixture(files: Record<string, string> = {}): Fixture {
	const fixture = makeFixtureProject({
		config: { buildOutputPath: PLACE, projectType: "luau" },
		files,
	});
	const place = path.join(fixture.project, PLACE);
	mkdirSync(path.dirname(place), { recursive: true });
	return {
		...fixture,
		forge: async (argv, variables = {}) => {
			return fixture.forge(argv, {
				FIXTURE_PLACE_CONTENT: PLACE_CONTENT,
				RBX_FORGE_NATIVE_DIR: NATIVE_DIRECTORY,
				RBX_FORGE_STUDIO_PATH: process.execPath,
				...variables,
			});
		},
		place,
		snapshots: path.join(fixture.project, ".forge", "snapshots"),
	};
}

/**
 * Wait for the fixture Studio to start: it may start after forge exited.
 *
 * @param log - The fixture log.
 * @returns The Studio's record.
 */
async function waitForStudioAsync(log: string): Promise<WorkerRecord> {
	const deadline = Date.now() + 20_000;
	let studio = readWorkerLog(log).find(({ role }) => role === "studio");
	while (studio === undefined && Date.now() < deadline) {
		await sleep(100);
		studio = readWorkerLog(log).find(({ role }) => role === "studio");
	}

	expect(studio, "the fixture Studio started").toBeDefined();

	return studio!;
}

/**
 * Install the fixture Rojo as a Node dependency so builds do not use ComSpec.
 *
 * @param project - The fixture project.
 */
function installNodeRojo(project: string): void {
	const directory = path.join(project, "node_modules", "fake-rojo");
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		path.join(project, "package.json"),
		JSON.stringify({ devDependencies: { "fake-rojo": "1.0.0" } }),
	);
	writeFileSync(
		path.join(directory, "package.json"),
		JSON.stringify({ name: "fake-rojo", bin: { rojo: "cli.mjs" } }),
	);
	writeFileSync(
		path.join(directory, "cli.mjs"),
		`process.argv.splice(2, 0, "rojo");\nawait import(${JSON.stringify(pathToFileURL(FAKE_WORKER).href)});\n`,
	);
}

describe("forge open", () => {
	it.skipIf(!IS_WINDOWS)(
		"dismisses a snapshot migration prompt after the open CLI has exited",
		{ timeout: 20_000 },
		async () => {
			expect.assertions(3);

			const fixture = await makeFixtureAsync({ projectType: "luau" }, { studio: true });
			const opened = await runForgeAsync(fixture, ["open", "--desktop", "hidden", "--json"], {
				FIXTURE_STUDIO_DIALOG_DELAY_MS: "7000",
			});

			expect(opened.status).toBe(EXIT_SUCCESS);

			const { place, studio } = parseOpened(opened.result.data);
			assert(studio !== null);
			await waitForFileAsync(`${place}.lock`);
			const pinned = loadRealNative().pinProcess(studio.pid);
			assert(pinned !== null);
			await sleep(8500);

			expect(pinned.isBlocked()).toBeFalse();
			expect(pinned.isAlive()).toBeTrue();
		},
	);

	it("should open a snapshot on the user desktop when the flag overrides hidden config", async () => {
		expect.assertions(3);

		const { forge, log } = makeFixture({
			"rbx-forge.config.json": JSON.stringify({
				buildOutputPath: PLACE,
				projectType: "luau",
				studio: { desktop: "hidden" },
			}),
		});
		const { status, stdout } = await forge(["open", "--desktop", "user", "--json"]);
		await waitForStudioAsync(log);

		expect(status).toBe(EXIT_SUCCESS);
		expect(parseResult(stdout).data).toMatchObject({
			desktop: "user",
			studio: { desktop: "user" },
		});
	});

	it.skipIf(!IS_WINDOWS)(
		"should warn and open the snapshot on the user desktop when a job forbids breakaway",
		async () => {
			expect.assertions(5);

			const fixture = await makeFixtureAsync({ projectType: "luau" }, { studio: true });
			installNodeRojo(fixture.project);
			const shell = makeRunScriptStudioExecutable();
			const child = spawn(process.execPath, [BIN, "open", "--desktop", "hidden", "--json"], {
				cwd: fixture.project,
				env: withVariables(
					fixture.environment(),
					{
						ComSpec: shell,
						FIXTURE_STUDIO_PLATFORM_LAUNCHER: "1",
						NODE_OPTIONS: `--import ${pathToFileURL(FORBID_BREAKAWAY).href}`,
					},
					"win32",
				),
				windowsHide: true,
			});
			onTestFinished(() => {
				child.kill();
			});
			let stdout = "";
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				stdout += chunk;
			});
			const code = await new Promise((resolve) => {
				child.once("close", resolve);
			});
			const { data } = parseResult(stdout);

			expect(code).toBe(EXIT_SUCCESS);
			expect(data).toMatchObject({ desktop: "user", studio: null });
			expect(parseLines(stdout)).toContainEqual({
				message:
					"Studio opened on the user's desktop: the platform launcher cannot use the hidden desktop.",
				type: "warning",
			});
			expect(readWorkerLog(fixture.log)).toContainEqual(
				expect.objectContaining({ role: "studio" }),
			);
			expect(existsSync(`${String(data!["place"])}.lock`)).toBeTrue();
		},
	);

	it("should build a snapshot, then start Studio with it directly, and Studio outlives forge", async () => {
		expect.assertions(5);

		const { forge, log, snapshots } = makeFixture();
		const { status, stdout } = await forge(["open", "--json"]);
		const studio = await waitForStudioAsync(log);
		const { data } = parseResult(stdout);
		const [name] = readdirSync(snapshots);
		const snapshot = path.join(snapshots, name!);

		expect(name).toMatch(SNAPSHOT_NAME);
		expect({ data, status }).toMatchObject({
			data: {
				build: { hooks: [], output: snapshot },
				desktop: "user",
				hooks: [],
				place: snapshot,
				pruned: [],
				studio: { pid: studio.pid },
			},
			status: EXIT_SUCCESS,
		});
		expect(studio.args).toStrictEqual([snapshot]);
		// forge has exited; the Studio it opened lives on.
		expect(isProcessAlive(studio.pid)).toBeTrue();
	});

	// POSIX gives an orphan a new parent (init or a subreaper) once forge
	// exits, often before Studio starts; Windows keeps the creator's PID.
	it.skipIf(!IS_WINDOWS)("should start Studio as forge's own child", async () => {
		expect.assertions(2);

		const { forge, log } = makeFixture();
		const { pid } = await forge(["open"]);
		const studio = await waitForStudioAsync(log);

		expect(studio.ppid).toBe(pid);
	});

	it("should keep the five newest snapshots, and every one a Studio has open", async () => {
		expect.assertions(3);

		const old = [0, 1, 2, 3, 4, 5].map((index) => `2020-01-01T00-00-0${index}-000_game.rbxl`);
		const files: Record<string, string> = {
			[`.forge/snapshots/${old[0]}.lock`]: "1\nRobloxStudioBeta\nhost\n",
		};
		for (const name of old) {
			files[`.forge/snapshots/${name}`] = PLACE_CONTENT;
		}

		const { forge, log, snapshots } = makeFixture(files);
		const { stdout } = await forge(["open", "--json"]);
		await waitForStudioAsync(log);
		const { data } = parseResult(stdout);

		expect(data).toMatchObject({ pruned: [path.join(snapshots, old[1]!)] });
		expect(new Set(readdirSync(snapshots))).toStrictEqual(
			new Set([
				`${old[0]}.lock`,
				old[0],
				...old.slice(2),
				path.basename(parseOpened(data).place),
			]),
		);
	});

	it("should open a snapshot while a session runs, and never the session's place", async () => {
		expect.assertions(4);

		const fixture = await makeFixtureAsync(
			{ ...WATCH_COMMAND, open: { buildFirst: true } },
			{ studio: true },
		);
		const up = await runForgeAsync(fixture, ["up", "--studio", "--json"]);
		const { result } = await runForgeAsync(fixture, ["open", "--json"]);
		const { place, studio } = parseOpened(result.data);
		await waitForFileAsync(`${place}.lock`);
		const serves = readWorkerLog(fixture.log).filter(
			({ args, role }) => `${role} ${args[0]}` === "rojo serve",
		);

		expect(up.status).toBe(EXIT_SUCCESS);
		expect(path.dirname(place)).toBe(path.join(fixture.project, ".forge", "snapshots"));
		expect(serves).toHaveLength(1);
		expect(
			readWorkerLog(fixture.log)
				.filter(({ role }) => role === "studio")
				.map(({ args, pid }) => ({ args, pid })),
		).toMatchObject([
			{
				args: [
					"--task",
					"RunScript",
					"--localPlaceFile",
					fixture.place,
					"--runScriptFile",
					path.join(path.dirname(wrapperPath(fixture)), "studio-marker.lua"),
				],
			},
			{ args: [place], pid: studio!.pid },
		]);
	});

	it("should sync a snapshot back with syncback --input", async () => {
		expect.assertions(2);

		const { forge, log } = makeFixture();
		const { stdout } = await forge(["open", "--json"]);
		const { place } = parseOpened(parseResult(stdout).data);
		const { status } = await forge(["syncback", "--input", place]);

		expect(status).toBe(EXIT_SUCCESS);
		expect(readWorkerLog(log).at(-1)).toMatchObject({
			args: ["syncback", "default.project.json", "--input", place, "--non-interactive"],
			role: "rojo",
		});
	});

	it("should start the Studio --studio-path names, over the variable", async () => {
		expect.assertions(3);

		const { forge, log, place } = makeFixture();
		const { status, stdout } = await forge(
			["open", "--json", "--studio-path", process.execPath],
			{ RBX_FORGE_STUDIO_PATH: path.join(place, "missing.exe") },
		);
		const studio = await waitForStudioAsync(log);

		expect(status).toBe(EXIT_SUCCESS);
		expect(parseResult(stdout).data).toMatchObject({ studio: { pid: studio.pid } });
	});

	it("should fail with studio_launch_failed when the Studio path names no file", async () => {
		expect.assertions(2);

		const { forge, place } = makeFixture();
		const missing = path.join(place, "missing.exe");
		const { status, stdout } = await forge(["open", "--json"], {
			RBX_FORGE_STUDIO_PATH: missing,
		});

		expect(status).toBe(EXIT_FAILURE);
		expect(parseResult(stdout).error).toMatchObject({
			code: "studio_launch_failed",
			hint: "Set RBX_FORGE_STUDIO_PATH to the Roblox Studio executable, or leave it unset.",
		});
	});

	// Windows' \`start\` opens the installed Studio through the \`.rbxl\` file
	// association; the fixture \`open\` and \`xdg-open\` on PATH stand in.
	it.skipIf(IS_WINDOWS)(
		"should open the snapshot through the platform launcher when it finds no Studio",
		async () => {
			expect.assertions(4);

			const { forge, log } = makeFixture();
			const { status, stdout } = await forge(["open", "--json"], {
				RBX_FORGE_STUDIO_PATH: "",
			});
			const studio = await waitForStudioAsync(log);
			const { data } = parseResult(stdout);

			expect(status).toBe(EXIT_SUCCESS);
			expect(data).toMatchObject({ studio: null });
			expect(studio.args).toStrictEqual([parseOpened(data).place]);
		},
	);

	it.skipIf(IS_WINDOWS)(
		"should fail with studio_launch_failed when the launcher fails",
		async () => {
			expect.assertions(2);

			const { forge } = makeFixture();
			const { status, stdout } = await forge(["open", "--json"], {
				FIXTURE_EXIT_CODE: "4",
				FIXTURE_FAIL_ROLE: LAUNCHER,
				RBX_FORGE_STUDIO_PATH: "",
			});

			expect(status).toBe(EXIT_FAILURE);
			expect(parseResult(stdout).error!.code).toBe("studio_launch_failed");
		},
	);
});
