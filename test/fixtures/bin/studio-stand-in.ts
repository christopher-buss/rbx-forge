/**
 * The `studio` role of `fake-worker.ts`: it stays alive until killed. Forge
 * starts it directly when `RBX_FORGE_STUDIO_PATH` names a copy of Node
 * named as Studio and the place holds {@link studioPlaceContent}; the
 * `open` and `xdg-open` launcher roles start it too. With
 * `FIXTURE_STUDIO_LOCK=1` it behaves as Studio with its place open:
 *
 * - It writes `<place>.lock` as Studio does: its PID, the executable name,
 *   and this computer's name; after `FIXTURE_STUDIO_LOCK_DELAY_MS` (default
 *   0), as Studio takes a while to open a place.
 * - On Windows it has a main window that is never shown (no window, no
 *   taskbar button), titled `<place> - Roblox Studio` as Studio's is; the
 *   addon at `FIXTURE_NATIVE_ADDON` makes it.
 * - A close request (Windows: `WM_CLOSE` to that window; elsewhere:
 *   `SIGTERM`) does what `FIXTURE_STUDIO_CLOSE` says: `exit` (the default)
 *   removes the lock file and exits; `dialog` stays open behind a modal
 *   dialog (Windows: its window is disabled, as Studio's is while it asks
 *   to save); `refuse` stays open and shows nothing; `linger` removes the
 *   lock file but the process runs on, as Studio's slow exit.
 * - With `FIXTURE_STUDIO_AUTOSAVE=1` it writes an auto-recovery file for
 *   its place, as Studio does now and then, into the AutoSaves folder under
 *   `LOCALAPPDATA` (Windows) or `HOME` (macOS).
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

/** The test exports of the addon that the stand-in uses (Windows). */
interface WindowAddon {
	openTestWindow: (title: string, visible: boolean) => number;
	setTestWindowEnabled: (window: number, enabled: boolean) => void;
	testWindowCloseRequests: () => number;
}

/** How often the stand-in looks for a close request on Windows. */
const CLOSE_POLL_MS = 50;
const KEEP_ALIVE_MS = 60_000;

const { env } = process;

const FAKE_WORKER = path.join(import.meta.dirname, "fake-worker.ts");

/**
 * What a place holds so that Node, started as Studio with the place as its
 * only argument, runs this stand-in: Node runs a file with an unknown
 * extension as CommonJS.
 *
 * @returns JavaScript that runs `fake-worker.ts` as `studio` with the
 *   place.
 */
export function studioPlaceContent(): string {
	const url = pathToFileURL(FAKE_WORKER).href;
	return `process.argv.push("studio", process.argv[1]); import(${JSON.stringify(url)});\n`;
}

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
	const window = openMainWindow(place);
	onCloseRequest(() => {
		closeOnRequest(lockPath, window);
	});
	if (env["FIXTURE_STUDIO_AUTOSAVE"] === "1") {
		writeAutoSave(place);
	}

	setTimeout(
		() => {
			writeFileSync(
				lockPath,
				`${process.pid}\nRobloxStudioBeta\n${os.hostname()}\n00000000-0000-0000-0000-000000000000\n`,
			);
		},
		Number(env["FIXTURE_STUDIO_LOCK_DELAY_MS"] ?? "0"),
	);
}

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

function loadAddon(): WindowAddon {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the addon exports these on Windows
	return createRequire(import.meta.url)(env["FIXTURE_NATIVE_ADDON"] ?? "") as WindowAddon;
}

/**
 * Windows: open the hidden main window.
 *
 * @param place - The place, for the title.
 * @returns The window's handle; `undefined` elsewhere.
 */
function openMainWindow(place: string): number | undefined {
	return process.platform === "win32"
		? loadAddon().openTestWindow(`${place} - Roblox Studio`, false)
		: undefined;
}

/**
 * What a close request does, as `FIXTURE_STUDIO_CLOSE` says.
 *
 * @param lockPath - The place's lock file.
 * @param window - The main window (Windows).
 */
function closeOnRequest(lockPath: string, window: number | undefined): void {
	switch (env["FIXTURE_STUDIO_CLOSE"]) {
		case "dialog": {
			if (window !== undefined) {
				loadAddon().setTestWindowEnabled(window, false);
			}

			break;
		}
		case "linger": {
			rmSync(lockPath, { force: true });
			break;
		}
		case "refuse": {
			break;
		}
		case "exit":
		case undefined:
		default: {
			rmSync(lockPath, { force: true });
			process.exit(0);
		}
	}
}

/**
 * Write `<place>_AutoRecovery_0.rbxl` into the first AutoSaves folder.
 *
 * @param place - The place Studio has open.
 */
function writeAutoSave(place: string): void {
	const root =
		process.platform === "win32"
			? path.join(env["LOCALAPPDATA"] ?? "", "Roblox", "RobloxStudio")
			: path.join(
					env["HOME"] ?? "",
					"Library",
					"Application Support",
					"Roblox",
					"RobloxStudio",
				);
	const folder = path.join(root, "AutoSaves");
	mkdirSync(folder, { recursive: true });
	const name = `${path.basename(place, path.extname(place))}_AutoRecovery_0.rbxl`;
	writeFileSync(path.join(folder, name), "auto-recovery\n");
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

	const addon = loadAddon();
	let handled = addon.testWindowCloseRequests();
	setInterval(() => {
		const requests = addon.testWindowCloseRequests();
		if (requests > handled) {
			handled = requests;
			onClose();
		}
	}, CLOSE_POLL_MS);
}
