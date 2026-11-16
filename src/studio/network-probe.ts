import { decode } from "@msgpack/msgpack";

import { type } from "arktype";
import { Buffer } from "node:buffer";

import type { CaptureListener } from "../capture/protocol.ts";
import { ForgeError } from "../errors.ts";
import { isHelperOperationFailure } from "../native/helper-client.ts";
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
 * @rejects Unreachable or mismatched Windows endpoint, cancellation, or an
 *   unavailable Windows helper.
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

	let expected: RojoServerInfo;
	try {
		expected = await seams.network.getRojoInfoAsync(port, signal);
	} catch (err) {
		signal.throwIfAborted();
		throw unreachable(err);
	}

	const body = await reachAsync(probe, port, "/api/rojo", signal);
	try {
		const actual = identityShape.assert(decode(body));
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
 * @rejects Unreachable or mismatched Windows endpoint, or an unavailable
 *   Windows helper.
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
		const body = await reachAsync(probe, Number(url.port), url.pathname + url.search);
		if (Buffer.from(body).toString("utf8") !== nonce) {
			throw unreachable(new Error("Windows reached a different capture listener."));
		}
	} catch (err) {
		listener.close();
		throw err;
	}
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

/**
 * Only a probe the helper ran and failed proves the endpoint unreachable;
 * helper, interop and cancellation failures keep their own classification.
 * @param probe - The Windows reachability probe.
 * @param port - The WSL port.
 * @param route - The path and query.
 * @param signal - Session cancellation.
 * @returns The body Windows read.
 * @rejects An unreachable endpoint, cancellation, or helper failure.
 */
async function reachAsync(
	probe: NonNullable<Seams["studioHost"]["probeHttpAsync"]>,
	port: number,
	route: string,
	signal?: AbortSignal,
): Promise<Uint8Array> {
	try {
		return await probe(port, route);
	} catch (err) {
		signal?.throwIfAborted();
		throw isHelperOperationFailure(err) ? unreachable(err) : err;
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
