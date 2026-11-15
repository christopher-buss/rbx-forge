import path from "node:path";

import type { CommandContext } from "../commands/context.ts";
import type { ResolvedConfig } from "../config/resolve.ts";
import { ForgeError, toForgeError } from "../errors.ts";
import { withVariables } from "../process/environment.ts";
import { runRojoAsync } from "../rojo/rojo.ts";
import type { PluginCapabilities } from "./rojo-plugin.ts";

export async function installWslPluginAsync(
	context: CommandContext,
	config: Pick<ResolvedConfig, "rojoAlias">,
	options: {
		prepare: (model: string) => PluginCapabilities;
		signal: AbortSignal;
		target: string;
	},
): Promise<PluginCapabilities> {
	const { fileSystem } = context.seams;
	const parent = path.join(context.cwd, ".forge");
	fileSystem.mkdirSync(parent, { recursive: true });
	const home = path.join(parent, `plugin-install-${context.seams.randomId()}`);
	fileSystem.mkdirSync(home);
	try {
		const model = await stageWslAsync(context, config, home);
		options.signal.throwIfAborted();
		const capabilities = options.prepare(model);
		if (capabilities.syncAcknowledgement) {
			publishModel(context, model, options.target);
		}

		return capabilities;
	} finally {
		fileSystem.rmSync(home, { recursive: true });
	}
}

async function stageWslAsync(
	context: CommandContext,
	config: Pick<ResolvedConfig, "rojoAlias">,
	home: string,
): Promise<string> {
	const { fileSystem } = context.seams;
	fileSystem.mkdirSync(path.join(home, "AppData", "Local", "Roblox"), { recursive: true });
	const studio = path.join(home, "studio");
	fileSystem.mkdirSync(path.join(studio, "content"), { recursive: true });
	const environment = withVariables(
		context.env,
		{ HOME: home, ROBLOX_STUDIO_PATH: studio },
		context.seams.host.platform,
	);
	await runRojoAsync({ ...context, env: environment }, config, ["plugin", "install"]);
	return path.join(home, "AppData", "Local", "Roblox", "Plugins", "RojoManagedPlugin.rbxm");
}

function publishModel(context: CommandContext, model: string, target: string): void {
	const { fileSystem, host } = context.seams;
	const temporary = `${target}.${host.pid}.tmp`;
	try {
		fileSystem.mkdirSync(path.dirname(target), { recursive: true });
		fileSystem.copyFileSync(model, temporary);
		fileSystem.renameSync(temporary, target);
	} catch (err) {
		throw new ForgeError(
			"plugin_write_failed",
			`Could not install the managed Rojo plugin: ${toForgeError(err).message}`,
			{ cause: err, hint: `Check permissions on ${target} and retry.` },
		);
	} finally {
		if (fileSystem.existsSync(temporary)) {
			fileSystem.rmSync(temporary);
		}
	}
}
