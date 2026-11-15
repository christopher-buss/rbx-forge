import { decode } from "@msgpack/msgpack";

import { type } from "arktype";
import { Buffer } from "node:buffer";

import type { CaptureListener } from "../capture/protocol.ts";
import { ForgeError } from "../errors.ts";
import type { RojoServerInfo } from "../seams/network.ts";
import type { Seams } from "../seams/seams.ts";

const identityShape = type({
	projectName: "string",
	protocolVersion: "number",
	serverVersion: "string",
	sessionId: "string",
});

/**
 * Verify Windows reaches this Rojo generation before publishing readiness.
 * @param seams - Network and Studio host boundaries.
 * @param port - The listening Rojo port.
 * @param signal - Session cancellation.
 * @rejects Unreachable or mismatched Windows endpoint, or cancellation.
 */
export async function probeRojoAsync(
	seams: Seams,
	port: number,
	signal: AbortSignal,
): Promise<void> {
	const probe = seams.studioHost.probeHttpAsync;
	if (probe === undefined) {
		return;
	}

	try {
		const expected = await seams.network.getRojoInfoAsync(port, signal);
		const actual = identityShape.assert(decode(await probe(port, "/api/rojo")));
		if (!sameIdentity(actual, expected)) {
			throw new Error("Windows reached a different Rojo identity.");
		}
	} catch (err) {
		throw unreachable(err);
	}

	signal.throwIfAborted();
}

/**
 * Verify a capture bind before its address is published or used.
 * @param seams - Windows reachability and entropy.
 * @param listener - The newly bound capture listener.
 * @rejects Unreachable or mismatched Windows endpoint.
 */
export async function probeCaptureAsync(seams: Seams, listener: CaptureListener): Promise<void> {
	const probe = seams.studioHost.probeHttpAsync;
	if (probe === undefined) {
		return;
	}

	try {
		const url = new URL(listener.url);
		const nonce = seams.randomId();
		url.pathname += `/probe/${nonce}`;
		const body = await probe(Number(url.port), url.pathname + url.search);
		if (Buffer.from(body).toString("utf8") !== nonce) {
			throw new Error("Windows reached a different capture listener.");
		}
	} catch (err) {
		listener.close();
		throw unreachable(err);
	}
}

function sameIdentity(actual: RojoServerInfo, expected: RojoServerInfo): boolean {
	return (
		actual.projectName === expected.projectName &&
		actual.sessionId === expected.sessionId &&
		actual.protocolVersion === expected.protocolVersion &&
		actual.serverVersion === expected.serverVersion
	);
}

function unreachable(cause: unknown): ForgeError {
	return new ForgeError(
		"wsl_network_unreachable",
		"Windows cannot reach the WSL session on IPv4 loopback.",
		{
			cause,
			hint: "Check WSL localhost forwarding, the networking mode (NAT or mirrored), and the Windows firewall.",
		},
	);
}
