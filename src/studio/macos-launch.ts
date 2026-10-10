import type { StudioDesktop } from "../config/schema.ts";
import { toForgeError } from "../errors.ts";
import type { NativeLoader } from "../native/addon.ts";
import type { KeepHiddenLauncher } from "./keep-hidden.ts";
import type { StudioLaunch, StudioProcess } from "./launcher.ts";

/** The app bundle LaunchServices opens for a macOS executable. */
const APP_EXECUTABLE = /^(?<bundle>.+\.app)\/Contents\/MacOS\/[^/]+$/;

/** Why a direct macOS launch could not honor the hidden desktop. */
export const UNBUNDLED_HIDDEN_WARNING =
	"Studio opened on the user's desktop: its executable is not in an app bundle LaunchServices can open hidden.";

/** What LaunchServices starts Studio with. */
interface BundleLaunch {
	args: Array<string>;
	desktop: StudioDesktop | undefined;
	env: Record<string, string>;
}

/**
 * Start Studio through LaunchServices; for the hidden desktop it is never
 * activated and is hidden as soon as it exists.
 *
 * @param native - The addon.
 * @param executable - The Studio executable.
 * @param launch - The arguments, environment, and desktop.
 * @returns Its PID, or why it did not start; `undefined` when the
 *   executable is in no app bundle or the addon cannot launch one.
 */
export async function launchServicesStartAsync(
	native: NativeLoader,
	executable: string,
	{ args, desktop, env }: BundleLaunch,
): Promise<number | string | undefined> {
	const bundle = APP_EXECUTABLE.exec(executable)?.groups?.["bundle"];
	const { launchApplication } = native();
	if (bundle === undefined || launchApplication === undefined) {
		return undefined;
	}

	const isHiding = desktop === "hidden";
	try {
		return await launchApplication({
			activates: !isHiding,
			args,
			bundle,
			env,
			hides: isHiding,
		});
	} catch (err) {
		return `Could not launch ${bundle}: ${toForgeError(err).message}`;
	}
}

/**
 * Keep hidden Studio windows hidden from a detached watcher.
 *
 * @param keepHidden - Starts the watcher.
 * @param launch - The place, directory, and environment.
 * @param platform - The host OS; Windows and macOS need the watcher.
 * @param studio - The pinned Studio and the desktop it got.
 * @returns A warning when the watcher could not start.
 */
export function keepHiddenWarning(
	keepHidden: KeepHiddenLauncher,
	{ cwd, env, place, runScript }: Pick<StudioLaunch, "cwd" | "env" | "place" | "runScript">,
	platform: NodeJS.Platform,
	studio: StudioProcess,
): string | undefined {
	if (studio.desktop !== "hidden") {
		return undefined;
	}

	if (platform === "win32" && runScript === undefined) {
		return undefined;
	}

	try {
		keepHidden({
			cwd,
			env,
			target: {
				...(platform === "win32" ? { isWindows: true } : {}),
				pid: studio.pid,
				place,
				startTime: studio.startTime,
			},
		});
		return undefined;
	} catch (err) {
		return `Studio opened hidden, but may show its windows while it loads: the watcher that keeps it hidden could not start: ${String(err)}`;
	}
}
