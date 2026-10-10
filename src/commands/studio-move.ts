import { type } from "arktype";

import type { FlagDefinition } from "../cli/flags.ts";
import { findSession } from "../client/session.ts";
import type { StudioDesktop } from "../config/schema.ts";
import { ForgeError } from "../errors.ts";
import { callSessionAsync } from "../ipc/client.ts";
import type { CommandResult } from "../seams/reporter.ts";
import { forgeFiles } from "../supervisor/session-files.ts";
import type { CommandContext, CommandInput } from "./context.ts";

export const STUDIO_MOVE_FLAGS: ReadonlyArray<FlagDefinition> = [];

const DESKTOP = "'user' | 'hidden'";
const moveResult = type({
	durationMs: "number",
	from: DESKTOP,
	pid: "number",
	to: DESKTOP,
});

/**
 * Ask the session to show or hide its Studio in place.
 * @param context - The project and seams.
 * @param _input - The command flags.
 * @param desktop - The target desktop.
 * @returns The visibility transition, unchanged PID, and elapsed time.
 * @rejects A stable session or visibility error.
 */
export async function runStudioMoveAsync(
	context: CommandContext,
	_input: CommandInput,
	desktop: StudioDesktop,
): Promise<CommandResult> {
	const session = findSession(context.seams.fileSystem, forgeFiles(context.cwd));
	if (session === undefined) {
		throw new ForgeError("studio_not_open", "No session Studio is open.");
	}

	movePlatform(context);
	const answer = await callSessionAsync(
		context.seams.ipc,
		{ endpoint: session.identity.endpoint, token: session.token },
		"moveStudio",
		{
			params: {
				desktop,
				sessionId: session.identity.sessionId,
			},
		},
	);
	return parseMoveResult(answer);
}

function movePlatform(context: CommandContext): NodeJS.Platform {
	const { platform } = context.seams.host;
	if (platform !== "win32" && platform !== "darwin") {
		throw new ForgeError("usage", "Showing and hiding Studio requires Windows or macOS.");
	}

	return platform;
}

function parseMoveResult(answer: Record<string, unknown>): CommandResult {
	const moved = moveResult(answer);
	if (moved instanceof type.errors) {
		throw new ForgeError(
			"internal_error",
			"The session answered moveStudio with something else.",
		);
	}

	return {
		data: { ...moved },
		summary: `Studio is ${moved.to === "hidden" ? "hidden" : "shown"} (PID ${moved.pid}).`,
	};
}
