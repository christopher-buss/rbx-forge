import { ForgeError } from "../errors.ts";
import type { Seams } from "../seams/seams.ts";
import { parseStatus } from "../session/status.ts";
import type { SessionFiles } from "./session-files.ts";
import { assertOwnSession } from "./side.ts";

/**
 * Keep an uncertain Windows Studio record until a healthy pin proves exit.
 * @param seams - Own-side identity, files and process-local Studio control.
 * @param files - The session whose Linux workers are already gone.
 * @rejects Unverified Studio cleanup or a foreign-side identity.
 */
export async function proveStudioCleanupAsync(
	seams: Pick<Seams, "host" | "studioHost"> & {
		fileSystem: Pick<Seams["fileSystem"], "existsSync" | "readFileSync">;
	},
	files: SessionFiles,
): Promise<void> {
	assertOwnSession(seams.host, seams.fileSystem, files.identity);
	if (!seams.fileSystem.existsSync(files.state)) {
		return;
	}

	const status = parseStatus(JSON.parse(seams.fileSystem.readFileSync(files.state, "utf8")));
	const studio = status?.services.studio;
	if (studio === undefined || !needsProof(studio)) {
		return;
	}

	try {
		if (studio.isLaunchUnknown || studio.pid === undefined || studio.startTime === undefined) {
			throw new Error("Studio identity is unknown.");
		}

		const pin = await seams.studioHost.pinProcessAsync(studio.pid, studio.startTime);
		if (pin !== null && (await pin.isAliveAsync())) {
			throw new Error("The recorded Windows Studio still runs.");
		}
	} catch (err) {
		throw new ForgeError(
			"cleanup_in_progress",
			"Windows Studio cleanup is unverified; the session identity record is retained.",
			{ cause: err },
		);
	}
}

function needsProof(studio: import("../session/status.ts").SessionStudio): boolean {
	if (studio.isLaunchUnknown) {
		return true;
	}

	if (studio.origin === "found") {
		return false;
	}

	if (studio.os === "win32" && studio.pid !== undefined) {
		return true;
	}

	return (
		studio.status !== "off" &&
		studio.status !== "closed" &&
		(studio.os === "win32" ||
			studio.control === "unavailable" ||
			studio.control === "recovering")
	);
}
