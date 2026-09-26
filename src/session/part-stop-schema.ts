import type { Type } from "arktype";
import { type } from "arktype";

import { ForgeError } from "../errors.ts";
import type { StudioStop } from "../studio/close-studio.ts";
import type { PartStops, StopPartsRequest } from "./part-stops.ts";

const PART = "'compiler' | 'rojo' | 'studio'";

const stopRequest = type({
	"force?": "boolean",
	"keepStudio?": "boolean",
	"place?": "string",
	"recovery?": "'delete' | 'keep' | 'move'",
	"scope": "'down' | 'restart' | 'stop'",
});

const recoveryReport = type({
	deleted: "string[]",
	mode: "'delete' | 'keep' | 'move'",
	moved: type({ from: "string", to: "string" }).array(),
	warnings: "string[]",
});

const studioStop: Type<StudioStop> = type.or(
	{
		end: "'dialog' | 'exited' | 'lock_released' | 'no_window' | 'timeout'",
		forced: "boolean",
		pid: "number.integer",
		recovery: recoveryReport.or("null"),
		status: "'stopped'",
	},
	{ pid: "number.integer", status: "'closed_first' | 'exited'" },
	{ status: "'not_open'" },
);

const stopsResult: Type<PartStops> = type({
	"ending": "boolean",
	"kept": type({ owner: "'start'", part: PART }).array(),
	"stopped": `(${PART})[]`,
	"studio?": type.or(
		{
			error: {
				"code": "string",
				"details?": "Record<string, unknown>",
				"hint?": "string",
				"message": "string",
			},
			place: "string",
		},
		{ place: "string", stop: studioStop },
	),
});

/**
 * Read what a `stopParts` request asks for.
 *
 * @param parameters - What the request sent.
 * @returns The scope, `force`, `keepStudio`, and the place and recovery mode
 *   when set.
 * @throws {ForgeError} `usage` when it is not a stop request.
 */
export function parseStopRequest(parameters: Record<string, unknown>): StopPartsRequest {
	const parsed = stopRequest(parameters);
	if (parsed instanceof type.errors) {
		throw new ForgeError("usage", `stopParts takes a scope: ${parsed.summary}`);
	}

	return {
		force: parsed.force === true,
		keepStudio: parsed.keepStudio === true,
		...(parsed.place === undefined ? {} : { place: parsed.place }),
		...(parsed.recovery === undefined ? {} : { recovery: parsed.recovery }),
		scope: parsed.scope,
	};
}

/**
 * Read what a session answered `stopParts` with.
 *
 * @param value - The `result` of the session's answer.
 * @returns What it stopped and kept, or `undefined` when it is not that.
 */
export function parseStopResult(value: unknown): PartStops | undefined {
	const parsed = stopsResult(value);
	return parsed instanceof type.errors ? undefined : parsed;
}
