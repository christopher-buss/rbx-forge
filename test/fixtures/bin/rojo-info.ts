import { encode } from "@msgpack/msgpack";

import { readFileSync } from "node:fs";
import process from "node:process";

/**
 * Rojo's msgpack identity for the generated fixture wrapper.
 *
 * @param projectPath - The served wrapper path.
 * @param serverVersion - The release advertised by the fake tool.
 * @returns An encoded `/api/rojo` response.
 */
export function fixtureRojoInfo(projectPath: string, serverVersion: string): Uint8Array {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- forge writes the generated project
	const project = JSON.parse(readFileSync(projectPath, "utf8")) as { name: string };
	return encode({
		projectName: project.name,
		protocolVersion: 5,
		serverVersion,
		sessionId: `fixture-rojo-${process.pid}`,
	});
}
