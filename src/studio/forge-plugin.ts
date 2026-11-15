import path from "node:path";

import type { CommandContext } from "../commands/context.ts";
import { ForgeError, toForgeError } from "../errors.ts";

/** The installed forge Studio plugin's file name. */
const FORGE_PLUGIN_FILE = "ForgePlugin.rbxm";

/**
 * Install the bundled forge Studio plugin before a direct Studio launch. A
 * byte-equal copy is left alone: a write reloads it in an open Studio.
 *
 * @param context - The environment, file system, and bundled plugin.
 * @rejects {ForgeError} `forge_plugin_write_failed` when it cannot be written.
 */
export async function installForgePluginAsync(
	context: Pick<CommandContext, "env" | "seams">,
): Promise<void> {
	const folder = await context.seams.studioHost.pluginsFolderAsync(context.env);
	if (folder === undefined) {
		return;
	}

	const { fileSystem, host } = context.seams;
	const target = path.join(folder, FORGE_PLUGIN_FILE);
	const temporary = `${target}.${host.pid}.tmp`;
	try {
		const bundled = context.seams.readForgePlugin();
		if (fileSystem.existsSync(target) && fileSystem.readFileSync(target).equals(bundled)) {
			return;
		}

		fileSystem.mkdirSync(folder, { recursive: true });
		fileSystem.writeFileSync(temporary, bundled);
		fileSystem.renameSync(temporary, target);
	} catch (err) {
		// `force` ignores only ENOENT; POSIX gives ENOTDIR when the folder is a
		// file.
		if (fileSystem.existsSync(temporary)) {
			fileSystem.rmSync(temporary);
		}

		throw new ForgeError(
			"forge_plugin_write_failed",
			`Could not install the forge Studio plugin: ${toForgeError(err).message}`,
			{ cause: err, hint: `Check permissions on ${target} and retry.` },
		);
	}
}
