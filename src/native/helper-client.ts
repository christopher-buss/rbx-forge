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
	identity: Promise<WindowsHelperIdentity>;
	requestAsync: (operation: Record<string, unknown>) => Promise<unknown>;
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
const operationFailures = new WeakSet<Error>();

class Channel {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly clock: Clock;
	private readonly pending = new Map<string, Pending>();

	private buffer = "";
	private failure: Error | undefined;
	private serial = 0;

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

	public async requestAsync(operation: Record<string, unknown>): Promise<unknown> {
		if (this.failure !== undefined) {
			throw this.failure;
		}

		this.serial += 1;
		const abort = new AbortController();
		const response = this.sendAsync(operation, String(this.serial), 10_000);
		const timer = this.deadlineAsync(abort.signal);
		try {
			return await response;
		} catch (err) {
			if (
				operation["op"] === "launch" &&
				(!(err instanceof Error) || !operationFailures.has(err))
			) {
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

	private async deadlineAsync(signal: AbortSignal): Promise<null> {
		return this.clock
			.sleep(10_000, signal)
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
 * Start one channel. Requests whose replies are lost are never replayed.
 * @param backend - Process and deadline dependencies.
 * @param locate - Absolute executable and fixed arguments.
 * @param arch - Linux package architecture.
 * @returns A channel that verifies the handshake before Studio operations.
 * @rejects Invalid helper paths and spawn failures.
 */
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
		identity,
		requestAsync: async (operation) => {
			await identity;
			return channel.requestAsync(operation);
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
