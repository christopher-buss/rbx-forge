import nodeFs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import type { KnownSession } from "../../src/client/session.ts";
import { findSession } from "../../src/client/session.ts";
import { ForgeError } from "../../src/errors.ts";
import { callSessionAsync } from "../../src/ipc/client.ts";
import { forgeFiles } from "../../src/supervisor/session-files.ts";
import { realTransport } from "../helpers/native-testing.ts";
import type { Project } from "./session-harness.ts";

const POLL_MS = 50;
const WAIT_MS = 30_000;

/**
 * Wait until the project's session answers: it writes its files before its
 * endpoint listens.
 *
 * @param project - Where it runs.
 * @returns Its files, identity record, and token.
 * @rejects When the bound passes first.
 */
export async function waitForSessionAsync(project: Project): Promise<KnownSession> {
	const deadline = Date.now() + WAIT_MS;
	for (;;) {
		const session = findSession(nodeFs, forgeFiles(project.project));
		if (session !== undefined && (await answersAsync(session))) {
			return session;
		}

		if (Date.now() > deadline) {
			throw new Error("timed out");
		}

		await sleep(POLL_MS);
	}
}

async function answersAsync(session: KnownSession): Promise<boolean> {
	const target = { endpoint: session.identity.endpoint, token: session.token };
	try {
		await callSessionAsync(realTransport(), target, "status");
		return true;
	} catch (err) {
		if (err instanceof ForgeError && err.code === "not_running") {
			return false;
		}

		throw err;
	}
}
