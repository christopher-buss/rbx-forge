import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";

import { EXIT_FAILURE, EXIT_SUCCESS } from "../../src/exit-codes.ts";
import type { FixtureProject } from "../helpers/fixture-project.ts";
import { makeFixtureProject } from "../helpers/fixture-project.ts";
import { parseResult } from "../helpers/output.ts";
import type { WorkerRecord } from "../helpers/worker-log.ts";
import { isProcessAlive, readWorkerLog } from "../helpers/worker-log.ts";

const FAKE_WORKER = path.join(import.meta.dirname, "..", "fixtures", "bin", "fake-worker.ts");
const IS_WINDOWS = process.platform === "win32";

/**
 * The place every test opens, in a folder with a space. On macOS and Linux
 * the fixture `open` and `xdg-open` on PATH stand in for the platform
 * launcher. Windows always opens through the real `start`, which picks the
 * app by file type, so there the "place" is a batch file that runs the
 * fixture Studio: real Roblox Studio never opens.
 */
const PLACE = IS_WINDOWS ? "My Places/Studio Stand-in.cmd" : "My Places/game.rbxl";

/**
 * The place's content. On Windows, the batch file that stands in for Studio:
 * it leaves the project folder (so the folder can be removed), runs the
 * fixture Studio with its own path, and closes its console once that is
 * killed. One line: cmd.exe reads it whole, so the file may be gone by then.
 */
const PLACE_CONTENT = IS_WINDOWS
	? `@cd /d "%SystemRoot%" & "${process.execPath}" "${FAKE_WORKER}" studio "%~f0" & exit\r\n`
	: "fake place\n";

interface Fixture extends FixtureProject {
	/** The absolute path of {@link PLACE}. */
	place: string;
}

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
			return fixture.forge(argv, { FIXTURE_PLACE_CONTENT: PLACE_CONTENT, ...variables });
		},
		place,
	};
}

/**
 * Wait for the fixture Studio to start: the launcher starts it after forge
 * may already have exited.
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
	it("should build the place, then open it in a Studio that is not a child of forge", async () => {
		expect.assertions(6);

		const { forge, log, place } = makeFixture();
		const { pid, status, stdout } = await forge(["open", "--json", "--place", PLACE]);
		const studio = await waitForStudioAsync(log);

		expect({ data: parseResult(stdout).data, status }).toMatchObject({
			data: { build: { hooks: [], output: place }, hooks: [], place },
			status: EXIT_SUCCESS,
		});
		expect(studio.args).toStrictEqual([place]);
		expect(pid).toBeNumber();
		expect(studio.ppid).not.toBe(pid);
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

	it.skipIf(IS_WINDOWS)(
		"should fail with studio_launch_failed when the launcher fails",
		async () => {
			expect.assertions(2);

			const { forge } = makeFixture({ hasPlace: true });
			const { status, stdout } = await forge(
				["open", "--no-build", "--place", PLACE, "--json"],
				{ FIXTURE_EXIT_CODE: "4" },
			);

			expect(status).toBe(EXIT_FAILURE);
			expect(parseResult(stdout).error!.code).toBe("studio_launch_failed");
		},
	);
});
