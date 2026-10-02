import path from "node:path";

import type { CommandContext } from "../commands/context.ts";
import { ForgeError, toForgeError } from "../errors.ts";
import { rojoWrapperPath } from "../rojo/wrapper-project.ts";
import type { RojoServerInfo } from "../seams/network.ts";

/**
 * Write the marker for the running wrapper's Rojo identity.
 *
 * @param context - The network and file system seams.
 * @param directory - Where this supervisor keeps its generated files.
 * @param port - Where the session's server listens on loopback.
 * @param signal - The session's end signal.
 * @returns The script path and validated Rojo identity.
 * @rejects Invalid Rojo identity, an identity mismatch, cancellation, or an I/O failure.
 */
export async function writeSessionMarkerAsync(
	{ seams }: CommandContext,
	directory: string,
	port: number,
	signal: AbortSignal,
): Promise<{ info: RojoServerInfo; runScript: string }> {
	let info: RojoServerInfo;
	try {
		info = await seams.network.getRojoInfoAsync(port, signal);
	} catch (err) {
		throw new ForgeError(
			"process_failed",
			`Could not read Rojo identity on port ${port}: ${toForgeError(err).message}`,
		);
	}

	const wrapper = JSON.parse(
		seams.fileSystem.readFileSync(rojoWrapperPath(directory), "utf8"),
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- forge wrote this wrapper
	) as { name: string };
	if (info.projectName !== wrapper.name) {
		throw new ForgeError(
			"process_failed",
			`Rojo on port ${port} serves ${info.projectName}, expected ${wrapper.name}.`,
		);
	}

	signal.throwIfAborted();
	const file = path.join(directory, "studio-marker.lua");
	seams.fileSystem.writeFileSync(file, markerScript(info, port));
	return { info, runScript: file };
}

function luaString(value: string): string {
	const literal = JSON.stringify(value);
	return literal.replace(/\\(?:u[0-9a-f]{4}|.)/gu, (escaped: string) => {
		return escaped.startsWith("\\u") ? `\\u{${escaped.slice(2)}}` : escaped;
	});
}

function markerScript(info: RojoServerInfo, port: number): string {
	const attributes: Record<string, string> = {
		Host: "127.0.0.1",
		Port: String(port),
		ProjectName: info.projectName,
		SessionId: info.sessionId,
	};
	const setters = Object.entries(attributes)
		.map(([name, value]) => `m:SetAttribute(${luaString(name)},${luaString(value)});`)
		.join("");
	return `local m=Instance.new("Configuration");m.Name="ROJO_OPEN_"..game:GetService("StudioService"):GetUserId();m.Archivable=false;${setters}m.Parent=game\n`;
}
