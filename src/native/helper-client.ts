import { type } from "arktype";
import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { Socket } from "node:net";
import path from "node:path";

import { ForgeError } from "../errors.ts";
import type { Clock } from "../seams/clock.ts";
import type { Seams } from "../seams/seams.ts";
import { handshakeWindowsHelperAsync, windowsHelperLaunchError } from "./windows-helper.ts";
import type { WindowsHelperIdentity } from "./windows-helper.ts";

/** The verified helper channel. */
export interface HelperClient {
	dispose?: () => void;
	identity: Promise<WindowsHelperIdentity>;
	onFailure?: (listener: (error: Error) => void) => void;
	requestAsync: (operation: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;
}

interface Pending {
	reject: (error: Error) => void;
	resolve: (value: unknown) => void;
}
const replyShape = type({
	"id": "string",
	"error?": { code: "string", message: "string" },
	"result?": "unknown",
});
const channelLosses = new WeakSet<Error>();

/**
 * Identify a command whose result was lost on the transport.
 * @param error - A command failure.
 * @returns Whether transport loss makes the result uncertain.
 */
export function isHelperChannelLoss(error: unknown): error is Error {
	return (
		error instanceof Error &&
		(channelLosses.has(error) ||
			(error instanceof ForgeError && isHelperChannelLoss(error.cause)))
	);
}

const operationFailures = new WeakSet<Error>();

class Channel {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly clock: Clock;
	private readonly pending = new Map<string, Pending>();

	private buffer = "";
	private failure: Error | undefined;
	private serial = 0;

	public onFailure: ((error: Error) => void) | undefined;

	constructor(child: ChildProcessWithoutNullStreams, clock: Clock) {
		this.child = child;
		this.clock = clock;
		child.on("error", (err) => {
			this.fail(windowsHelperLaunchError(err));
		});
		child.on("exit", () => {
			this.fail(new Error("Windows helper exited."));
		});
		child.stdin.on("error", (err) => {
			this.fail(err);
		});
		child.stdout.on("error", (err) => {
			this.fail(err);
		});
		child.stdout.on("end", () => {
			this.fail(new Error("Windows helper EOF."));
		});
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			this.receive(chunk);
		});
	}

	public dispose(): void {
		this.fail(new ForgeError("windows_helper_unavailable", "Windows helper channel disposed."));
	}

	public async requestAsync(
		operation: Record<string, unknown>,
		timeoutMs = 10_000,
	): Promise<unknown> {
		if (this.failure !== undefined) {
			throw this.failure;
		}

		this.serial += 1;
		const abort = new AbortController();
		const response = this.sendAsync(operation, String(this.serial), timeoutMs);
		const timer = this.deadlineAsync(abort.signal, timeoutMs);
		try {
			return await response;
		} catch (err) {
			if (operation["op"] === "launch" && !isHelperOperationFailure(err)) {
				throw new ForgeError(
					"studio_launch_unknown",
					"The Studio launch reply was lost. Check Studio before trying again.",
					{ cause: err },
				);
			}

			throw err;
		} finally {
			abort.abort();
			await timer;
		}
	}

	private async deadlineAsync(signal: AbortSignal, timeoutMs: number): Promise<null> {
		return this.clock
			.sleep(timeoutMs, signal)
			.then(() => {
				this.fail(new Error("Windows helper request deadline elapsed."));
				return null;
			})
			.catch(() => null);
	}

	private fail(err: Error): void {
		if (this.failure !== undefined) {
			return;
		}

		this.failure = err;
		if (!(err instanceof ForgeError) && !(err instanceof SyntaxError)) {
			channelLosses.add(err);
		}

		this.onFailure?.(err);
		for (const request of this.pending.values()) {
			request.reject(err);
		}

		// Stryker disable next-line CallExpression: releases references after
		// the channel is terminal.
		this.pending.clear();
		this.child.stdin.destroy();
		this.child.stdout.destroy();
		this.child.stderr.destroy();
		this.child.kill();
	}

	private receive(chunk: string): void {
		this.buffer += chunk;
		if (this.buffer.length > 1024 * 1024) {
			this.fail(
				new ForgeError("windows_helper_unavailable", "Windows helper reply exceeds 1 MiB."),
			);
			return;
		}

		let newline = this.buffer.indexOf("\n");
		while (newline !== -1) {
			const line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			try {
				this.reply(line);
			} catch (err) {
				assert(err instanceof Error);
				this.fail(err);
				return;
			}

			newline = this.buffer.indexOf("\n");
		}
	}

	private reply(line: string): void {
		const reply: unknown = JSON.parse(line);
		if (!replyShape.allows(reply) || "error" in reply === "result" in reply) {
			throw new ForgeError("windows_helper_unavailable", "Malformed Windows helper reply.");
		}

		const request = this.pending.get(reply.id);
		if (request === undefined) {
			throw new ForgeError("windows_helper_unavailable", "Unknown Windows helper reply id.");
		}

		this.pending.delete(reply.id);
		if (reply.error === undefined) {
			request.resolve(reply.result);
		} else {
			const failure = new ForgeError("windows_helper_unavailable", reply.error.message);
			operationFailures.add(failure);
			request.reject(failure);
		}
	}

	private async sendAsync(
		operation: Record<string, unknown>,
		id: string,
		timeoutMs: number,
	): Promise<unknown> {
		return new Promise((resolve, reject) => {
			this.pending.set(id, { reject, resolve });
			try {
				this.child.stdin.write(
					`${JSON.stringify({ ...operation, id, deadlineMs: this.clock.now() + timeoutMs })}\n`,
					(err) => {
						if (err) {
							this.fail(err);
						}
					},
				);
			} catch (err) {
				assert(err instanceof Error);
				this.fail(err);
			}
		});
	}
}

/**
 * Identify a failure the helper reported for a delivered command.
 * @param error - A command failure.
 * @returns Whether the helper ran the operation and refused or failed it.
 */
export function isHelperOperationFailure(error: unknown): error is ForgeError {
	return error instanceof ForgeError && operationFailures.has(error);
}

/**
 * Start one channel. Requests whose replies are lost are never replayed.
 * @param backend - Process and deadline dependencies.
 * @param locate - Absolute executable and fixed arguments.
 * @param arch - Linux package architecture.
 * @returns A channel that verifies the handshake before Studio operations.
 * @rejects Invalid helper paths and spawn failures.
 */
// eslint-disable-next-line flawless/max-lines-per-function -- Starts the transport and binds its lifecycle in one place.
export function createHelperClient(
	backend: Pick<Seams, "childProcess" | "clock">,
	locate: () => { args: Array<string>; file: string },
	arch: string,
): HelperClient {
	const invocation = locate();
	if (!path.isAbsolute(invocation.file)) {
		throw new ForgeError(
			"windows_helper_unavailable",
			"The Windows helper path must be absolute.",
		);
	}

	const child = backend.childProcess.spawn(invocation.file, invocation.args, {
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	releaseEventLoop(child);
	const channel = new Channel(child, backend.clock);
	const identity = handshakeWindowsHelperAsync(arch, async (operation) => {
		return channel.requestAsync(operation);
	});
	return {
		dispose: () => {
			channel.dispose();
		},
		identity,
		onFailure: (listener) => {
			channel.onFailure = listener;
		},
		requestAsync: async (operation, timeoutMs) => {
			await identity;
			return channel.requestAsync(operation, timeoutMs);
		},
	};
}

function releaseEventLoop(child: ChildProcessWithoutNullStreams): void {
	child.unref();
	for (const stream of [child.stdin, child.stdout, child.stderr]) {
		if (stream instanceof Socket) {
			stream.unref();
		}
	}

	child.stderr.resume();
}
