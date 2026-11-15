/* oxlint-disable typescript/require-await -- The async host wraps synchronous addon calls and turns throws into rejections. */
import type { FileLock, PinnedProcess, SaveOutcome } from "../native/addon.ts";
import { autoSaveDirectories } from "../studio/auto-recovery.ts";
import type { StudioExecutable } from "../studio/discover.ts";
import type { StudioLaunch, StudioLauncher, StudioLaunchOutcome } from "../studio/launcher.ts";
import { studioPluginsFolder } from "../studio/plugins-folder.ts";
import { findStudioExecutable } from "./addon-studio/discover.ts";
import type { InstalledStudio } from "./addon-studio/discover.ts";
import type { Environment, Seams } from "./seams.ts";

/** A Studio identity whose operations always act on its held native pin. */
export interface PinnedStudio {
	activateAppAsync: () => Promise<boolean>;
	appActiveAsync: () => Promise<boolean | null>;
	appHiddenAsync: () => Promise<boolean | null>;
	desktopAsync: () => Promise<"hidden" | "user">;
	dismissDialogAsync: (
		title: string,
		button: string,
		desktop: "hidden" | "user",
		timeoutMs?: number,
	) => Promise<boolean>;
	executablePathAsync: () => Promise<null | string>;
	isAliveAsync: () => Promise<boolean>;
	isBlockedAsync: () => Promise<boolean>;
	killAsync: () => Promise<boolean>;
	os?: NodeJS.Platform;
	readonly pid: number;
	requestCloseAsync: () => Promise<boolean>;
	requestSaveAsync: (timeoutMs?: number) => Promise<SaveOutcome>;
	saveMenuEnabledAsync: (timeoutMs: number) => Promise<boolean>;
	setAppHiddenAsync: (hidden: boolean) => Promise<boolean>;
	setWindowVisibilityAsync: (visibility: "active" | "hidden" | "user") => Promise<boolean>;
	readonly startTime: string;
	startWindowHidingAsync: () => Promise<boolean>;
	stopWindowHidingAsync: () => Promise<boolean>;
	waitForExitAsync: (timeoutMs: number) => Promise<boolean>;
	windowHidingAsync: () => Promise<boolean>;
	windowVisibilityAsync: () => Promise<"hidden" | "user" | null>;
}

/** A Windows singleton lock held through the Studio host. */
export interface StudioHostLock {
	releaseAsync: () => Promise<void>;
}

/**
 * Studio OS operations; worker, local lock, and IPC operations stay on Seams.
 */
export interface StudioHost {
	autoSaveDirectoriesAsync: (environment: Environment) => Promise<Array<string>>;
	findStudioExecutableAsync: (options: {
		env: Environment;
		studioPath?: string | undefined;
	}) => Promise<StudioExecutable | undefined>;
	fromHostPathAsync: (path: string) => Promise<string>;
	frontmostApplicationAsync: () => Promise<null | number>;
	hostnameAsync: () => Promise<string>;
	launchAsync: (launch: StudioLaunch) => Promise<StudioLaunchOutcome>;
	pinProcessAsync: (pid: number, startTime?: string) => Promise<null | PinnedStudio>;
	platformAsync: () => Promise<NodeJS.Platform>;
	pluginsFolderAsync: (environment: Environment) => Promise<string | undefined>;
	processStartTimeAsync: (pid: number) => Promise<null | string>;
	/**
	 * Native paths are unchanged; the WSL implementation converts at this
	 * boundary.
	 */
	toHostPathAsync: (path: string) => Promise<string>;
	tryLockFileAsync: (path: string) => Promise<null | StudioHostLock>;
}

/** Dependencies shared with the existing native Studio entry points. */
export type AddonStudioHostBackend = Pick<Seams, "fileSystem" | "host" | "native"> & {
	installedStudio: InstalledStudio;
	studioLauncher: StudioLauncher;
};

/**
 * Build the native Studio host without loading the addon until an operation needs it.
 * @param backend - Native process control, discovery, and launch dependencies.
 * @returns An async boundary over the existing platform implementations.
 */
export function createAddonStudioHost(backend: AddonStudioHostBackend): StudioHost {
	return {
		autoSaveDirectoriesAsync: async (environment) => {
			return autoSaveDirectories(environment, backend.host.platform);
		},
		findStudioExecutableAsync: async (options) => findStudioExecutable(backend, options),
		fromHostPathAsync: async (path) => path,
		frontmostApplicationAsync: async () => backend.native().frontmostApplication(),
		hostnameAsync: async () => backend.host.hostname,
		launchAsync: async (launch) => backend.studioLauncher(launch),
		pinProcessAsync: async (pid, startTime) => {
			const pin = backend.native().pinProcess(pid);
			if (pin === null || (startTime !== undefined && pin.startTime !== startTime)) {
				return null;
			}

			return wrapPin(pin);
		},
		platformAsync: async () => backend.host.platform,
		pluginsFolderAsync: async (environment) => {
			return studioPluginsFolder({ env: environment, seams: { host: backend.host } });
		},
		processStartTimeAsync: async (pid) => backend.native().processStartTime(pid),
		toHostPathAsync: async (path) => path,
		tryLockFileAsync: async (path) => {
			const lock = backend.native().tryLockFile(path, "exclusive");
			return lock === null ? null : wrapLock(lock);
		},
	};
}

function wrapPin(pin: PinnedProcess): PinnedStudio {
	return {
		activateAppAsync: async () => pin.activateApp(),
		appActiveAsync: async () => pin.appActive(),
		appHiddenAsync: async () => pin.appHidden(),
		desktopAsync: async () => pin.desktop(),
		dismissDialogAsync: async (title, button, desktop, timeoutMs) => {
			return pin.dismissDialog(title, button, desktop, timeoutMs);
		},
		executablePathAsync: async () => pin.executablePath(),
		isAliveAsync: async () => pin.isAlive(),
		isBlockedAsync: async () => pin.isBlocked(),
		killAsync: async () => pin.kill(),
		pid: pin.pid,
		requestCloseAsync: async () => pin.requestClose(),
		requestSaveAsync: async (timeoutMs) => pin.requestSave(timeoutMs),
		saveMenuEnabledAsync: async (timeoutMs) => pin.saveMenuEnabled(timeoutMs),
		setAppHiddenAsync: async (hidden) => pin.setAppHidden(hidden),
		setWindowVisibilityAsync: async (visibility) => pin.setWindowVisibility(visibility),
		startTime: pin.startTime,
		startWindowHidingAsync: async () => pin.startWindowHiding(),
		stopWindowHidingAsync: async () => pin.stopWindowHiding(),
		waitForExitAsync: async (timeoutMs) => pin.waitForExit(timeoutMs),
		windowHidingAsync: async () => pin.windowHiding(),
		windowVisibilityAsync: async () => pin.windowVisibility(),
	};
}

function wrapLock(lock: FileLock): StudioHostLock {
	return {
		releaseAsync: async () => {
			lock.release();
		},
	};
}
