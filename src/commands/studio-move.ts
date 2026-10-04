import { type } from "arktype";
import path from "node:path";

import type { FlagDefinition } from "../cli/flags.ts";
import { findSession } from "../client/session.ts";
import type { StudioDesktop } from "../config/schema.ts";
import { ForgeError } from "../errors.ts";
import { callSessionAsync } from "../ipc/client.ts";
import type { CommandResult } from "../seams/reporter.ts";
import { STUDIO_OPEN_BOUND_MS } from "../session/studio-readiness.ts";
import { STUDIO_PATH_FLAG } from "../studio/discover.ts";
import { STUDIO_SAVE_TIMEOUT_MS } from "../studio/save-studio.ts";
import { forgeFiles } from "../supervisor/session-files.ts";
import type { CommandContext, CommandInput } from "./context.ts";

export const STUDIO_MOVE_FLAGS: ReadonlyArray<FlagDefinition> = [
	STUDIO_PATH_FLAG,
	{
		name: "timeout",
		kind: "string",
		text: "Wait at most this many seconds for the save before moving Studio (default: 30).",
		value: "<s>",
	},
];

const DESKTOP = "'user' | 'hidden'";
const moveResult = type({
	durationMs: "number",
	from: DESKTOP,
	pid: "number",
	save: {
		bytes: "number",
		desktop: DESKTOP,
		durationMs: "number",
		mtime: "string",
		pid: "number",
		place: "string",
	},
	to: DESKTOP,
});

/**
 * Ask the session to save and move its Studio between Windows desktops.
 * @param context - The project and seams.
 * @param input - The timeout and Studio path.
 * @param desktop - The target desktop.
 * @returns The actual desktops, new PID, and save metadata.
 * @rejects A stable session, save, close, or launch error.
 */
export async function runStudioMoveAsync(
	context: CommandContext,
	input: CommandInput,
	desktop: StudioDesktop,
): Promise<CommandResult> {
	const timeoutMs = saveTimeout(input);
	const session = findSession(context.seams.fileSystem, forgeFiles(context.cwd));
	if (session === undefined) {
		throw new ForgeError("studio_not_open", "No session Studio is open.");
	}

	if (context.seams.host.platform !== "win32") {
		throw new ForgeError("usage", "Moving Studio between desktops requires Windows.");
	}

	context.reporter.emit({
		message: "Reopening Studio loses undo history and open script tabs.",
		type: "warning",
	});
	const answer = await callSessionAsync(
		context.seams.ipc,
		{ endpoint: session.identity.endpoint, token: session.token },
		"moveStudio",
		{
			params: {
				desktop,
				sessionId: session.identity.sessionId,
				studioPath: resolveStudioPath(context, input),
				timeoutMs,
			},
			responseTimeoutMs: timeoutMs + STUDIO_OPEN_BOUND_MS + 60_000,
		},
	);
	return parseMoveResult(answer);
}

function resolveStudioPath(context: CommandContext, { flags }: CommandInput): string | undefined {
	const studioPath = flags["studio-path"];
	return typeof studioPath === "string" ? path.resolve(context.cwd, studioPath) : undefined;
}

function saveTimeout({ flags }: CommandInput): number {
	const value = flags["timeout"];
	const timeoutMs = value === undefined ? STUDIO_SAVE_TIMEOUT_MS : Number(value) * 1000;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new ForgeError("usage", "--timeout must be a positive number of seconds.");
	}

	return timeoutMs;
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
		summary: `Studio is on the ${moved.to} desktop (PID ${moved.pid}).`,
	};
}
