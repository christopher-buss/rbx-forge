import { type } from "arktype";

import { ForgeError } from "../errors.ts";

/** Identity returned by protocol version 1 of the Windows helper. */
export interface WindowsHelperIdentity {
	helperArch: string;
	hostname: string;
	protocol: number;
	windowsArch: string;
}

const identityShape = type({
	helperArch: "string",
	hostname: "string > 0",
	protocol: "1",
	windowsArch: "string",
});
const INSTALL_HINT =
	"Reinstall rbx-forge with optional dependencies and the Windows helper matching your Linux architecture.";
const INTEROP_HINT =
	"Enable [interop] enabled=true in /etc/wsl.conf, restart WSL with `wsl --shutdown` from Windows, and check that Windows executables run from this distro.";

/**
 * Classify an actual helper launch or channel failure; environment variables do
 * not prove whether WSL interop works.
 * @param cause - The spawn or channel error.
 * @returns A stable failure and a repair hint.
 */
export function windowsHelperLaunchError(cause: unknown): ForgeError {
	const code =
		typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
	const isMissing = code === "ENOENT" || code === "EACCES" || code === "EPERM";
	return new ForgeError(
		isMissing ? "windows_helper_unavailable" : "wsl_interop_unavailable",
		`Could not start the Windows helper channel: ${cause instanceof Error ? cause.message : String(cause)}`,
		{
			cause,
			hint: isMissing ? INSTALL_HINT : INTEROP_HINT,
		},
	);
}

/**
 * Establish the helper identity before any Studio operation. The request callback
 * starts the helper on first use and returns the decoded result of its reply.
 * @param arch - The Linux package architecture (`x64` or `arm64`).
 * @param requestAsync - A deadline-bounded request over the helper channel.
 * @returns The verified Windows identity.
 * @rejects {ForgeError} A missing, incompatible, or unreachable Windows helper.
 */
export async function handshakeWindowsHelperAsync(
	arch: string,
	requestAsync: (operation: { op: "handshake"; protocol: 1 }) => Promise<unknown>,
): Promise<WindowsHelperIdentity> {
	let result: unknown;
	try {
		result = await requestAsync({ op: "handshake", protocol: 1 });
	} catch (err) {
		if (err instanceof ForgeError) {
			throw err;
		}

		throw windowsHelperLaunchError(err);
	}

	if (
		!identityShape.allows(result) ||
		result.helperArch !== arch ||
		result.windowsArch !== arch
	) {
		throw new ForgeError(
			"windows_helper_unavailable",
			"The Windows helper handshake has an invalid protocol, architecture, or Windows host name.",
			{ hint: INSTALL_HINT },
		);
	}

	return result;
}
