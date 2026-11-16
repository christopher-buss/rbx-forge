import { ForgeError } from "../errors.ts";
import type { FileSystem } from "../seams/file-system.ts";
import type { Host } from "../seams/host.ts";

/**
 * The OS side that owns a supervisor and its workers.
 * @param host - The local OS and WSL distro.
 * @returns The persistent side name.
 */
export function sideOf(host: Pick<Host, "platform" | "wslDistro">): string {
	if (host.platform === "linux" && host.wslDistro !== undefined) {
		return `wsl:${host.wslDistro}`;
	}

	return host.platform === "win32" ? "windows" : host.platform;
}

/**
 * Refuse before interpreting a foreign PID, contacting IPC, or removing files.
 * @param host - The local OS and distro.
 * @param side - The recorded side, absent in legacy records.
 */
export function assertOwnSide(
	host: Pick<Host, "platform" | "wslDistro">,
	side: string | undefined,
): void {
	if (side !== undefined && side !== sideOf(host)) {
		throw new ForgeError("identity_mismatch", `This session belongs to ${side}.`, {
			hint: `Run "forge down" on ${side}, then try again here.`,
		});
	}
}

/**
 * Read the side independently of the rest of a possibly incomplete identity.
 * @param host - The local OS and distro.
 * @param fs - Reads the identity record.
 * @param identity - The identity file path.
 */
export function assertOwnSession(
	host: Pick<Host, "platform" | "wslDistro">,
	fs: Pick<FileSystem, "readFileSync">,
	identity: string,
): void {
	let text: string;
	try {
		text = fs.readFileSync(identity, "utf8");
	} catch (err) {
		if (err instanceof Error && "code" in err && err.code === "ENOENT") {
			return;
		}

		throw new ForgeError(
			"identity_mismatch",
			"The session side cannot be verified because its identity record could not be read.",
			{
				hint: 'Restore access to supervisor.id and run "forge down" on the side that started it.',
			},
		);
	}

	assertSideInText(host, text);
}

function assertSideInText(host: Pick<Host, "platform" | "wslDistro">, text: string): void {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		// Legacy malformed records have no side to compare.
	}

	if (
		typeof value === "object" &&
		value !== null &&
		"side" in value &&
		typeof value.side === "string"
	) {
		assertOwnSide(host, value.side);
	}
}
