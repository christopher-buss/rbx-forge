import { type } from "arktype";
import assert from "node:assert/strict";

import { createHelperClient } from "../../src/native/helper-client.ts";
import { nodeClock } from "../../src/seams/clock.ts";
import type { StudioHost } from "../../src/seams/studio-host.ts";
import { createWslStudioHost } from "../../src/seams/wsl-studio-host.ts";
import { createFakeSpawner } from "./fake-process.ts";
import type { FakeChild } from "./fake-process.ts";
import { createTestSeams } from "./seams.ts";

const IDENTITY = { helperArch: "x64", hostname: "WINDOWS", protocol: 1, windowsArch: "x64" };
const request = type({ "id": "string", "op": "string", "route?": "string" });

/**
 * A Windows reachability probe through the real helper protocol.
 * @param respond - The body the helper reads at a route; a rejection is the
 *   helper's failed probe.
 * @param launch - A spawn error code, for a helper that never starts.
 * @returns The WSL Studio host's probe.
 */
export function createHelperProbe(
	respond: (route: string) => Promise<Uint8Array>,
	launch?: string,
): NonNullable<StudioHost["probeHttpAsync"]> {
	const seams = createTestSeams({ clock: nodeClock });
	const spawner = createFakeSpawner((child) => {
		if (launch === undefined) {
			serve(child, respond);
		} else {
			child.error(Object.assign(new Error(`spawn ${launch}`), { code: launch }));
		}
	});
	const host = createWslStudioHost({ ...seams, cwd: "/", environment: {} }, () => {
		return createHelperClient(
			{ ...seams, childProcess: spawner.runner },
			() => ({ args: [], file: "/helper.exe" }),
			"x64",
		);
	});
	const { probeHttpAsync } = host;
	assert(probeHttpAsync !== undefined);
	return probeHttpAsync;
}

function serve(child: FakeChild, respond: (route: string) => Promise<Uint8Array>): void {
	child.stdin.setEncoding("utf8");
	child.stdin.on("data", (line: string) => {
		const { id, op, route } = request.assert(JSON.parse(line));
		if (op === "handshake") {
			child.stdout.write(`${JSON.stringify({ id, result: IDENTITY })}
`);
			return;
		}

		void respond(route ?? "")
			.then((body) => ({ id, result: [...body] }))
			.catch((err: unknown) => {
				const message = err instanceof Error ? err.message : String(err);
				return { id, error: { code: "operation_failed", message } };
			})
			.then((reply) => {
				child.stdout.write(`${JSON.stringify(reply)}
`);
			});
	});
}
