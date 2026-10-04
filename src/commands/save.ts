import { type } from "arktype";

import type { FlagDefinition } from "../cli/flags.ts";
import { findSession } from "../client/session.ts";
import { ForgeError } from "../errors.ts";
import { callSessionAsync } from "../ipc/client.ts";
import type { CommandResult } from "../seams/reporter.ts";
import { STUDIO_SAVE_TIMEOUT_MS } from "../studio/save-studio.ts";
import { forgeFiles } from "../supervisor/session-files.ts";
import type { CommandContext, CommandInput } from "./context.ts";

export const SAVE_FLAGS: ReadonlyArray<FlagDefinition> = [
	{
		name: "timeout",
		kind: "string",
		text: "Wait at most this many seconds for Studio to save (default: 30).",
		value: "<s>",
	},
];

const saveResult = type({
	bytes: "number",
	desktop: "'user' | 'hidden'",
	durationMs: "number",
	mtime: "string",
	pid: "number",
	place: "string",
});

/**
 * Ask the session to save its Studio before syncback reads its place.
 * @param context - The project and seams.
 * @param input - The timeout flag.
 * @returns The saved place and its disk metadata.
 * @rejects A stable Studio or save error, or an invalid timeout.
 */
export async function runSaveAsync(
	context: CommandContext,
	input: CommandInput,
): Promise<CommandResult> {
	const value = input.flags["timeout"];
	const timeoutMs = value === undefined ? STUDIO_SAVE_TIMEOUT_MS : Number(value) * 1000;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new ForgeError("usage", "--timeout must be a positive number of seconds.");
	}

	const session = findSession(context.seams.fileSystem, forgeFiles(context.cwd));
	if (session === undefined) {
		throw new ForgeError("studio_not_open", "No session Studio is open.", {
			hint: 'Open one with "forge up --studio".',
		});
	}

	const answer = await callSessionAsync(
		context.seams.ipc,
		{ endpoint: session.identity.endpoint, token: session.token },
		"save",
		{
			params: { sessionId: session.identity.sessionId, timeoutMs },
			responseTimeoutMs: timeoutMs + 2000,
		},
	);
	const parsed = saveResult(answer);
	if (parsed instanceof type.errors) {
		throw new ForgeError("internal_error", "The session answered save with something else.");
	}

	return {
		data: parsed,
		summary: `Saved ${parsed.place} in Roblox Studio (PID ${parsed.pid}, desktop ${parsed.desktop}).`,
	};
}
