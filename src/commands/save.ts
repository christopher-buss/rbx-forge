import { type } from "arktype";
import path from "node:path";

import type { FlagDefinition } from "../cli/flags.ts";
import { findSession } from "../client/session.ts";
import { ForgeError } from "../errors.ts";
import { callSessionAsync } from "../ipc/client.ts";
import type { CommandResult } from "../seams/reporter.ts";
import { saveTimeoutMs, studioSaveResult } from "../studio/save-contract.ts";
import type { StudioSave } from "../studio/save-studio.ts";
import { saveStudioAsync } from "../studio/save-studio.ts";
import { forgeFiles } from "../supervisor/session-files.ts";
import type { CommandContext, CommandInput } from "./context.ts";

export const SAVE_FLAGS: ReadonlyArray<FlagDefinition> = [
	{
		name: "place",
		kind: "string",
		text: "Save the Studio that has this snapshot place open, without a session.",
		value: "<path>",
	},
	{
		name: "timeout",
		kind: "string",
		text: "Wait at most this many seconds for Studio to save (default: 30).",
		value: "<s>",
	},
];

/**
 * Save a snapshot Studio directly, or ask the session to save its Studio.
 * @param context - The project and seams.
 * @param input - The snapshot place and timeout flags.
 * @returns The saved place and its disk metadata.
 * @rejects A stable Studio or save error, or an invalid timeout.
 */
export async function runSaveAsync(
	context: CommandContext,
	input: CommandInput,
): Promise<CommandResult> {
	const timeoutMs = saveTimeoutMs(input.flags["timeout"]);

	const { place } = input.flags;
	const saved =
		typeof place === "string"
			? await saveStudioAsync(
					context.seams,
					{ place: path.resolve(context.cwd, place) },
					timeoutMs,
				)
			: await saveSessionAsync(context, timeoutMs);
	return saveResultOf(saved);
}

async function saveSessionAsync(context: CommandContext, timeoutMs: number): Promise<StudioSave> {
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
	const parsed = studioSaveResult(answer);
	if (parsed instanceof type.errors) {
		throw new ForgeError("internal_error", "The session answered save with something else.");
	}

	return parsed;
}

function saveResultOf(saved: StudioSave): CommandResult {
	return {
		data: { ...saved },
		summary: `Saved ${saved.place} in Roblox Studio (PID ${saved.pid}, desktop ${saved.desktop}).`,
	};
}
