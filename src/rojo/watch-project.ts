import type { FSWatcher } from "node:fs";
import path from "node:path";

import type { CommandContext } from "../commands/context.ts";
import type { ResolvedConfig } from "../config/resolve.ts";
import type { SessionScope } from "../session/run-session.ts";
import { rojoWrapperPath } from "./wrapper-project.ts";

/**
 * Reload Rojo's nested project on edits while keeping its root identity.
 *
 * @param context - The project root, file system, and reporter.
 * @param setup - The user's project and this Rojo's wrapper and lifetime.
 * @param scope - The session's cancellation and tracked work.
 */
export function watchRojoProject(
	{ cwd, reporter, seams: { fileSystem } }: CommandContext,
	{
		config,
		directory,
		stopped,
	}: {
		config: Pick<ResolvedConfig, "rojoProjectPath">;
		directory: string;
		stopped: Promise<void>;
	},
	scope: Pick<SessionScope, "signal" | "track">,
): void {
	const project = path.resolve(cwd, config.rojoProjectPath);
	const wrapper = rojoWrapperPath(directory);
	const content = fileSystem.readFileSync(wrapper);
	function warn(error: unknown): void {
		reporter.emit({
			message: `Cannot reload Rojo project ${project}: ${String(error)}.`,
			type: "warning",
		});
	}

	// Watch the directory so replacing the project does not strand its watch.
	let watcher: FSWatcher;
	try {
		watcher = fileSystem.watch(path.dirname(project));
	} catch (err) {
		warn(err);
		return;
	}

	watcher.on("change", (_event: string, filename: null | string) => {
		if (filename === null || filename === path.basename(project)) {
			try {
				fileSystem.writeFileSync(wrapper, content);
			} catch (err) {
				warn(err);
			}
		}
	});
	closeWithRojo(watcher, scope, stopped, warn);
}

/**
 * Close a directory watch with its Rojo or the session.
 *
 * @param watcher - The directory watch.
 * @param scope - The session's cancellation and tracked work.
 * @param stopped - This Rojo's stop.
 * @param warn - Report a watcher error.
 */
function closeWithRojo(
	watcher: FSWatcher,
	scope: Pick<SessionScope, "signal" | "track">,
	stopped: Promise<void>,
	warn: (error: unknown) => void,
): void {
	function close(): void {
		scope.signal.removeEventListener("abort", close);
		watcher.close();
	}

	watcher.on("error", (error) => {
		warn(error);
		close();
	});
	scope.signal.addEventListener("abort", close);
	scope.track(stopped.then(close));
}
