/**
 * The `studio` role of `fake-worker.ts`, which its launcher roles start: it
 * stays alive until killed. With
 * `FIXTURE_STUDIO_LOCK=1` it behaves as Roblox Studio with its place open:
 *
 * - It writes `<place>.lock` as Studio does: its PID, the executable name,
 *   and this computer's name.
 * - On a close request (Windows: `WM_CLOSE` to its main window, which the
 *   addon at `FIXTURE_NATIVE_ADDON` opens; elsewhere: `SIGTERM`), it removes
 *   the lock file and exits, or with `FIXTURE_STUDIO_REFUSE_CLOSE=1` stays
 *   open, as Studio does while it asks to save changes.
 */
import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";

/** The test exports of the addon that the stand-in uses (Windows). */
interface WindowAddon {
	openTestWindow: () => void;
	testWindowCloseRequests: () => number;
}

/** How often the stand-in looks for a close request on Windows. */
const CLOSE_POLL_MS = 50;
const KEEP_ALIVE_MS = 60_000;

const { env } = process;

/**
 * Stay alive, and behave as Studio with `place` open, when
 * `FIXTURE_STUDIO_LOCK=1`.
 *
 * @param place - The place the launcher handed over.
 */
export function runStudio(place: string | undefined): void {
	setInterval(stayAlive, KEEP_ALIVE_MS);
	if (place === undefined || env["FIXTURE_STUDIO_LOCK"] !== "1") {
		return;
	}

	const lockPath = `${place}.lock`;
	onCloseRequest(() => {
		if (env["FIXTURE_STUDIO_REFUSE_CLOSE"] === "1") {
			return;
		}

		rmSync(lockPath, { force: true });
		process.exit(0);
	});
	writeFileSync(
		lockPath,
		`${process.pid}\nRobloxStudioBeta\n${os.hostname()}\n00000000-0000-0000-0000-000000000000\n`,
	);
}

const FAKE_WORKER = path.join(import.meta.dirname, "fake-worker.ts");

/**
 * Start a detached `studio` with the launcher's arguments, as a platform
 * launcher hands a file to its app. It runs `FIXTURE_STUDIO_EXE` when set.
 *
 * @param args - The launcher's arguments: the place.
 */
export function launchStudio(args: ReadonlyArray<string>): void {
	const executable = env["FIXTURE_STUDIO_EXE"] ?? process.execPath;
	const studio = spawn(executable, [FAKE_WORKER, "studio", ...args], {
		detached: true,
		stdio: "ignore",
		windowsHide: true,
	});
	studio.unref();
}

function stayAlive(): void {
	// The interval keeps the process alive.
}

/**
 * Call `onClose` on each close request: `WM_CLOSE` to a main window on
 * Windows, `SIGTERM` elsewhere.
 *
 * @param onClose - What a close request does.
 */
function onCloseRequest(onClose: () => void): void {
	if (process.platform !== "win32") {
		process.on("SIGTERM", onClose);
		return;
	}

	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the addon exports these on Windows
	const addon = createRequire(import.meta.url)(env["FIXTURE_NATIVE_ADDON"] ?? "") as WindowAddon;
	addon.openTestWindow();
	let handled = 0;
	setInterval(() => {
		const requests = addon.testWindowCloseRequests();
		if (requests > handled) {
			handled = requests;
			onClose();
		}
	}, CLOSE_POLL_MS);
}
