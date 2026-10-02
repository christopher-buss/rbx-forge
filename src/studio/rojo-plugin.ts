import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";

import type { CommandContext } from "../commands/context.ts";
import type { ResolvedConfig } from "../config/resolve.ts";
import { ForgeError, toForgeError } from "../errors.ts";
import { readVariable } from "../process/environment.ts";
import { runRojoAsync } from "../rojo/rojo.ts";
import stock from "./rojo-plugin/stock.json" with { type: "json" };

/**
 * Whether forge can guarantee automatic sync and acknowledge its completion.
 */
export interface PluginCapabilities {
	autoConnect: boolean;
	source: "forge" | "manual" | "upstream";
	syncAcknowledgement: boolean;
}

/** Current patch version, shared with the readable source distribution. */
export const VERSION = 1;
/** Script bodies and provenance for the source distribution. */
export const SCRIPTS: ReadonlyArray<{ hash: string; name: string; source: string }> = [
	{
		name: "App",
		hash: "f7facea2cd39479ede1349b0042633c8228b8a41d602831f1928a1e43f7b1f15",
		source: stock.App,
	},
	{
		name: "ServeSession",
		hash: "e7a8fe67a0ff8229d13680fedfec2228fc2d23561bf2a512d1032bb7517c111a",
		source: stock.ServeSession,
	},
];

const MANUAL: PluginCapabilities = {
	autoConnect: false,
	source: "manual",
	syncAcknowledgement: false,
};
const FORGE: PluginCapabilities = {
	autoConnect: false,
	source: "forge",
	syncAcknowledgement: false,
};
const MARK = /^-- rbx-forge patch (\d+) stock ([a-f0-9]{64})\n/u;
const PROTOCOL = /\bprotocolVersion\s*=\s*(\d+)\s*[,}]/u;

/**
 * Ensure a coherent managed plugin only for a new direct Studio launch.
 *
 * @param context - The original project, addon, file system, and reporter.
 * @param config - The project's Rojo command.
 * @param protocolVersion - The validated session server's protocol.
 * @param signal - The session's end signal.
 * @returns Capabilities of the prepared plugin.
 * @rejects Installation failure, protocol mismatch, atomic write failure, or cancellation.
 */
export async function prepareRojoPluginAsync(
	context: CommandContext,
	config: Pick<ResolvedConfig, "rojoAlias">,
	protocolVersion: number,
	signal: AbortSignal,
): Promise<PluginCapabilities> {
	const model = pluginPath(context);
	if (model === undefined) {
		return MANUAL;
	}

	if (!context.seams.fileSystem.existsSync(model)) {
		await runRojoAsync(context, config, ["plugin", "install"]);
		signal.throwIfAborted();
	}

	const sources = readSources(context, model);
	if (sources === undefined) {
		return MANUAL;
	}

	const decision = decide(context, sources, protocolVersion);
	if (decision !== "patch") {
		return decision;
	}

	signal.throwIfAborted();
	writeSources(context, model);
	return FORGE;
}

function pluginPath({ env, seams }: CommandContext): string | undefined {
	const { platform } = seams.host;
	const home = readVariable(env, platform === "win32" ? "USERPROFILE" : "HOME", platform);
	if (home === undefined || home === "") {
		return undefined;
	}

	if (platform === "win32") {
		return path.join(home, "AppData", "Local", "Roblox", "Plugins", "RojoManagedPlugin.rbxm");
	}

	return platform === "darwin"
		? path.join(home, "Documents", "Roblox", "Plugins", "RojoManagedPlugin.rbxm")
		: undefined;
}

function manual(context: CommandContext, reason: string): PluginCapabilities {
	context.reporter.emit({
		message: `${reason} Auto-connect is off; connect to Rojo manually in Studio.`,
		type: "warning",
	});
	return MANUAL;
}

function readSources(context: CommandContext, model: string): Array<string> | undefined {
	try {
		return context.seams
			.native()
			.readModelScriptSources(model, [
				...SCRIPTS.map(({ name }) => ["Rojo", "Plugin", name]),
				["Rojo", "Plugin", "Config"],
			]);
	} catch (err) {
		manual(context, `Could not read the managed Rojo plugin: ${toForgeError(err).message}.`);
		return undefined;
	}
}

function checkProtocol(context: CommandContext, source: string, serverProtocol: number): boolean {
	const protocol = PROTOCOL.exec(source)?.[1];
	if (protocol === undefined) {
		manual(context, "Could not identify the managed Rojo plugin protocol.");
		return false;
	}

	if (Number(protocol) !== serverProtocol) {
		throw new ForgeError(
			"plugin_protocol_mismatch",
			`Rojo plugin protocol ${protocol} differs from server protocol ${serverProtocol}.`,
			{ hint: "Restore the plugin with the project's rojo plugin install." },
		);
	}

	return true;
}

function recognizes(
	{ hash, source: original }: { hash: string; source: string },
	source: string,
): boolean {
	const mark = MARK.exec(source);
	return mark === null
		? createHash("sha256").update(source).digest("hex") === hash
		: mark[2] === hash &&
				Number(mark[1]) <= VERSION &&
				source.slice(mark[0].length) === original;
}

function upstream(context: CommandContext): PluginCapabilities {
	context.reporter.emit({
		message:
			"The Rojo plugin handles launch markers upstream; confirm the sync in Studio if prompted. Forge cannot acknowledge its initial sync.",
		type: "warning",
	});
	return { autoConnect: false, source: "upstream", syncAcknowledgement: false };
}

function decide(
	context: CommandContext,
	sources: Array<string>,
	serverProtocol: number,
): "patch" | PluginCapabilities {
	const [app, session, configSource] = sources;
	assert(app !== undefined);
	assert(session !== undefined);
	assert(configSource !== undefined);
	if (!checkProtocol(context, configSource, serverProtocol)) {
		return MANUAL;
	}

	if (app.includes("ROJO_OPEN_") && !MARK.test(app) && session.includes("expectedSessionId")) {
		return upstream(context);
	}

	const isRecognized = SCRIPTS.every((script, index) => {
		const source = sources[index];
		assert(source !== undefined);
		return recognizes(script, source);
	});
	if (!isRecognized) {
		return manual(
			context,
			"The managed Rojo plugin has unsupported or manually changed sources.",
		);
	}

	return [app, session].every((source) => Number(MARK.exec(source)?.[1]) === VERSION)
		? FORGE
		: "patch";
}

function writeSources(context: CommandContext, model: string): void {
	try {
		context.seams.native().writeModelScriptSources(
			model,
			SCRIPTS.map(({ name, hash, source }) => {
				return {
					path: ["Rojo", "Plugin", name],
					source: `-- rbx-forge patch ${VERSION} stock ${hash}\n${source}`,
				};
			}),
		);
	} catch (err) {
		throw new ForgeError(
			"plugin_write_failed",
			`Could not patch the managed Rojo plugin: ${toForgeError(err).message}`,
			{ cause: err, hint: "Check permissions on RojoManagedPlugin.rbxm and retry." },
		);
	}
}
