import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

import type { StopSource } from "../session/stop-source.ts";
import { parseOwnerLine } from "./channel.ts";

/**
 * Watch the owner pipe (the supervisor's stdin, whose only write end
 * `forge start` holds): a stop line passes on the signal `start` got; EOF
 * or a read error means `start` is gone, however it died. Call it first
 * thing, so no request is lost.
 *
 * @param input - The owner pipe.
 * @param stop - Gets each request.
 */
export function watchOwner(input: Readable, stop: StopSource): void {
	const lines = createInterface({ input });
	lines.on("line", (line) => {
		const request = parseOwnerLine(line);
		if (request !== undefined) {
			stop.request(request);
		}
	});
	function gone(): void {
		stop.request({ type: "owner_gone" });
	}

	lines.once("close", gone);
	// readline passes the pipe's errors on to the interface.
	lines.on("error", gone);
}
