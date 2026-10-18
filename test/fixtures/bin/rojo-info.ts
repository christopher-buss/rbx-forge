import { encode } from "@msgpack/msgpack";

import { type } from "arktype";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import process from "node:process";

const wrapperCapture = type({
	tree: { "ServerStorage?": { "ForgeCapture?": { $attributes: { CaptureUrl: "string" } } } },
});

/**
 * The capture configuration received through the stand-in's Rojo wrapper.
 * @param projectPath - The served wrapper path.
 * @returns The JSON capture URL advertisement.
 */
export function fixtureCaptureInfo(projectPath: string): string {
	const wrapper = wrapperCapture.assert(JSON.parse(readFileSync(projectPath, "utf8")));
	return JSON.stringify({
		url: wrapper.tree.ServerStorage?.ForgeCapture?.$attributes.CaptureUrl,
	});
}

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

/**
 * Serve the stand-in's Rojo identity and wrapper capture configuration.
 * @param args - Rojo serve arguments.
 * @param environment - The fixture's environment switches.
 * @param version - The advertised Rojo version.
 */
export function listenFixtureRojo(
	args: ReadonlyArray<string>,
	environment: NodeJS.ProcessEnv,
	version: string,
): void {
	const index = args.indexOf("--port");
	const port = index === -1 ? undefined : args[index + 1];
	if (port === undefined || environment["FIXTURE_ROJO_NO_LISTEN"] === "1") {
		return;
	}

	setTimeout(
		() => {
			const server = createServer((request, response) => {
				if (request.url === "/forge-capture") {
					const body = fixtureCaptureInfo(args[1] ?? "");
					response.writeHead(200, {
						"content-length": Buffer.byteLength(body),
						"content-type": "application/json",
					});
					response.end(body);
					return;
				}

				response.end(fixtureRojoInfo(args[1] ?? "", version));
			});
			server.on("error", (err) => {
				process.stderr.write(`listen failed: ${err.message}\n`);
			});
			server.listen({ host: "127.0.0.1", port: Number(port) });
		},
		Number(environment["FIXTURE_ROJO_LISTEN_DELAY_MS"] ?? "0"),
	);
}
