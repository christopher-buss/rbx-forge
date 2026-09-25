import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";

import { EXIT_FAILURE, EXIT_SUCCESS } from "../../src/exit-codes.ts";
import { studioPlaceContent } from "../fixtures/bin/studio-stand-in.ts";
import type { FixtureProject } from "../helpers/fixture-project.ts";
import { makeFixtureProject } from "../helpers/fixture-project.ts";
import { parseResult } from "../helpers/output.ts";
import { NATIVE_DIRECTORY } from "../helpers/real-native.ts";
import type { WorkerRecord } from "../helpers/worker-log.ts";
import { isProcessAlive, readWorkerLog } from "../helpers/worker-log.ts";

const IS_WINDOWS = process.platform === "win32";

/** The place every test opens, in a folder with a space. */
const PLACE = "My Places/game.rbxl";

/**
 * The place's content: Node, started as Studio with the place, runs the
 * fixture Studio (`test/fixtures/bin/studio-stand-in.ts`).
 */
const PLACE_CONTENT = studioPlaceContent();

interface Fixture extends FixtureProject {
	/** The absolute path of {@link PLACE}. */
	place: string;
}

/**
 * A project whose `forge` starts Node as Studio, directly, through the
 * native addon.
 *
 * @param options - Whether the place exists already.
 * @param options.hasPlace - Write it now.
 * @returns The project.
 */
function makeFixture({ hasPlace = false }: { hasPlace?: boolean } = {}): Fixture {
	const fixture = makeFixtureProject({
		config: { projectType: "luau" },
		files: hasPlace ? { [PLACE]: PLACE_CONTENT } : {},
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

describe("forge open", () => {
	it("should build the place, then start Studio with it directly, and Studio outlives forge", async () => {
		expect.assertions(5);

		const { forge, log, place } = makeFixture();
		const { pid, status, stdout } = await forge(["open", "--json", "--place", PLACE]);
		const studio = await waitForStudioAsync(log);

		expect({ data: parseResult(stdout).data, status }).toMatchObject({
			data: {
				build: { hooks: [], output: place },
				hooks: [],
				place,
				studio: { pid: studio.pid },
			},
			status: EXIT_SUCCESS,
		});
		expect(studio.args).toStrictEqual([place]);
		// Studio is forge's child, out of its job, and runs on without it.
		expect(studio.ppid).toBe(pid);
		// forge has exited; the Studio it opened lives on.
		expect(isProcessAlive(studio.pid)).toBeTrue();
	});

	it("should open an existing place without building it with --no-build", async () => {
		expect.assertions(4);

		const { forge, log, place } = makeFixture({ hasPlace: true });
		const { status } = await forge(["open", "--no-build", "--place", PLACE]);
		const studio = await waitForStudioAsync(log);

		expect(status).toBe(EXIT_SUCCESS);
		expect(studio.args).toStrictEqual([place]);
		expect(readWorkerLog(log).map(({ role }) => role)).not.toContain("rojo");
	});

	it("should start the Studio --studio-path names, over the variable", async () => {
		expect.assertions(3);

		const { forge, log, place } = makeFixture({ hasPlace: true });
		const { status, stdout } = await forge(
			["open", "--no-build", "--place", PLACE, "--json", "--studio-path", process.execPath],
			{ RBX_FORGE_STUDIO_PATH: path.join(place, "missing.exe") },
		);
		const studio = await waitForStudioAsync(log);

		expect(status).toBe(EXIT_SUCCESS);
		expect(parseResult(stdout).data).toMatchObject({ studio: { pid: studio.pid } });
	});

	it("should fail with studio_launch_failed when the Studio path names no file", async () => {
		expect.assertions(2);

		const { forge, place } = makeFixture({ hasPlace: true });
		const missing = path.join(place, "missing.exe");
		const { status, stdout } = await forge(["open", "--no-build", "--place", PLACE, "--json"], {
			RBX_FORGE_STUDIO_PATH: missing,
		});

		expect(status).toBe(EXIT_FAILURE);
		expect(parseResult(stdout).error).toMatchObject({
			code: "studio_launch_failed",
			hint: "Set RBX_FORGE_STUDIO_PATH to the Roblox Studio executable, or leave it unset.",
		});
	});

	it("should fail with place_not_found for a missing place when it cannot ask", async () => {
		expect.assertions(4);

		const { forge, log, place } = makeFixture();
		const { status, stdout } = await forge(["open", "--no-build", "--place", PLACE, "--json"]);

		expect(status).toBe(EXIT_FAILURE);
		expect(parseResult(stdout).error).toMatchObject({
			code: "place_not_found",
			message: `${place} does not exist.`,
		});
		expect(existsSync(place)).toBeFalse();
		expect(readWorkerLog(log)).toStrictEqual([]);
	});

	// Windows would find the installed Studio in the registry; the fixture
	// \`open\` and \`xdg-open\` on PATH stand in for the platform launcher.
	it.skipIf(IS_WINDOWS)(
		"should open the place through the platform launcher when it finds no Studio",
		async () => {
			expect.assertions(3);

			const { forge, log, place } = makeFixture({ hasPlace: true });
			const { status, stdout } = await forge(
				["open", "--no-build", "--place", PLACE, "--json"],
				{ RBX_FORGE_STUDIO_PATH: "" },
			);
			const studio = await waitForStudioAsync(log);

			expect(status).toBe(EXIT_SUCCESS);
			expect(parseResult(stdout).data).toMatchObject({ studio: null });
			expect(studio.args).toStrictEqual([place]);
		},
	);

	it.skipIf(IS_WINDOWS)(
		"should fail with studio_launch_failed when the launcher fails",
		async () => {
			expect.assertions(2);

			const { forge } = makeFixture({ hasPlace: true });
			const { status, stdout } = await forge(
				["open", "--no-build", "--place", PLACE, "--json"],
				{ FIXTURE_EXIT_CODE: "4", RBX_FORGE_STUDIO_PATH: "" },
			);

			expect(status).toBe(EXIT_FAILURE);
			expect(parseResult(stdout).error!.code).toBe("studio_launch_failed");
		},
	);
});
