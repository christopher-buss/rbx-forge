import { type } from "arktype";
import assert from "node:assert/strict";

import { ForgeError } from "../errors.ts";
import type { HelperClient } from "../native/helper-client.ts";
import type { Clock } from "./clock.ts";
import { pinnedIdentity } from "./wsl-helper-results.ts";

const identityText = type("string | null");

/**
 * Logical Windows identities survive a helper generation; native handles do
 * not.
 */
export class HelperHandles {
	private readonly clock: Clock;
	private readonly locks = new Map<string, { lock: string; path: string }>();
	private readonly pins = new Map<
		string,
		{ pid: number; pin: null | string; startTime: string }
	>();
	private readonly unavailable: (error: Error) => void;

	constructor(clock: Clock, unavailable: (error: Error) => void) {
		this.clock = clock;
		this.unavailable = unavailable;
	}

	public isGone(pin: unknown): boolean {
		return this.pins.get(String(pin))?.pin === null;
	}

	// eslint-disable-next-line flawless/max-lines-per-function -- Validates and records complete identity replies.
	public remember(operation: Record<string, unknown>, result: unknown): unknown {
		if (operation["op"] === "pin" || operation["op"] === "launch") {
			let identity: ReturnType<typeof pinnedIdentity>;
			try {
				identity = pinnedIdentity(result);
			} catch (err) {
				assert(err instanceof Error);
				this.unavailable(err);
				if (operation["op"] === "launch") {
					throw new ForgeError(
						"studio_launch_unknown",
						"The Windows helper returned no usable Studio launch identity. Check Studio before trying again.",
						{ cause: err },
					);
				}

				throw err;
			}

			const token = `pin:${identity.pid}:${identity.startTime}`;
			this.pins.set(token, identity);
			return { ...identity, pin: token };
		}

		if (result !== null && operation["op"] === "tryLockFile") {
			const token = `lock:${type("string").assert(operation["path"])}`;
			this.locks.set(token, {
				lock: type("string").assert(result),
				path: type("string").assert(operation["path"]),
			});
			return token;
		}

		this.locks.delete(String(operation["lock"]));

		return result;
	}

	public async restoreAsync(next: HelperClient, deadline: number): Promise<void> {
		for (const lock of this.locks.values()) {
			const value = identityText.assert(
				await next.requestAsync(
					{ op: "tryLockFile", path: lock.path },
					Math.max(1, deadline - this.clock.now()),
				),
			);
			if (value === null) {
				throw new ForgeError(
					"windows_helper_unavailable",
					"Windows singleton lock could not be retaken.",
				);
			}

			lock.lock = value;
		}

		for (const pin of this.pins.values()) {
			await this.repinAsync(next, pin, deadline);
		}
	}

	public translate(operation: Record<string, unknown>): Record<string, unknown> {
		const pin = this.pins.get(String(operation["pin"]));
		if (pin?.pin === null) {
			// A reused PID is never a target for the old logical pin.
			throw new ForgeError("identity_mismatch", "The pinned Windows Studio has exited.");
		}

		const lock = this.locks.get(String(operation["lock"]));
		return {
			...operation,
			...(pin === undefined ? {} : { pin: pin.pin }),
			...(lock === undefined ? {} : { lock: lock.lock }),
		};
	}

	private async repinAsync(
		next: HelperClient,
		pin: { pid: number; pin: null | string; startTime: string },
		deadline: number,
	): Promise<void> {
		const start = identityText.assert(
			await next.requestAsync(
				{ op: "processStartTime", pid: pin.pid },
				Math.max(1, deadline - this.clock.now()),
			),
		);
		if (start !== pin.startTime) {
			pin.pin = null;
			return;
		}

		const value = pinnedIdentity(
			await next.requestAsync(
				{ op: "pin", pid: pin.pid, startTime: pin.startTime },
				Math.max(1, deadline - this.clock.now()),
			),
		);
		if (value.pid !== pin.pid || value.startTime !== pin.startTime) {
			throw new ForgeError(
				"windows_helper_unavailable",
				"Windows helper returned a different Studio identity.",
			);
		}

		pin.pin = value.pin;
	}
}
