import assert from "node:assert/strict";

import { ForgeError } from "../errors.ts";
import { isHelperChannelLoss } from "../native/helper-client.ts";
import type { HelperClient } from "../native/helper-client.ts";
import type { Clock } from "./clock.ts";
import { HelperHandles } from "./helper-handles.ts";
import type { StudioControl } from "./studio-host.ts";

const ATTEMPTS = 3;
const BACKOFF_MS = 100;
const ATTEMPT_MS = 1000;
const RESET_MS = 60_000;
const reads = new Set([
	"autoSaveDirectories",
	"desktop",
	"executablePath",
	"isAlive",
	"isBlocked",
	"pluginsFolder",
	"probeHttp",
	"processStartTime",
	"readRegistry",
	"saveMenuEnabled",
	"windowHiding",
	"windowVisibility",
]);

/**
 * Process-local recovery owns logical pins and locks across helper
 * generations.
 */
export class HelperRecovery {
	private readonly clock: Clock;
	private readonly connect: () => HelperClient;
	private readonly handles: HelperHandles;
	private readonly listeners = new Set<(state: StudioControl) => void>();

	private attempts = 0;
	private client: HelperClient | undefined;
	private failure: Error | undefined;
	private flight: Promise<void> | undefined;
	private hostname: string | undefined;
	private readyAt = 0;
	private state: StudioControl = "ready";

	constructor(connect: () => HelperClient, clock: Clock) {
		this.connect = connect;
		this.clock = clock;
		this.handles = new HelperHandles(clock, this.unavailable.bind(this));
	}

	public async identityAsync(): Promise<{ hostname: string }> {
		await this.ensureAsync();
		assert(this.hostname !== undefined);
		return { hostname: this.hostname };
	}

	public observe(listener: (state: StudioControl) => void): () => void {
		this.listeners.add(listener);
		listener(this.state);
		return () => {
			this.listeners.delete(listener);
		};
	}

	public async requestAsync(
		operation: Record<string, unknown>,
		timeoutMs = 10_000,
	): Promise<unknown> {
		const deadline = this.clock.now() + timeoutMs;
		await (this.flight === undefined
			? this.ensureAsync()
			: this.withinAsync(this.flight, timeoutMs));

		const { client } = this;
		assert(client !== undefined);
		try {
			if (operation["op"] === "isAlive" && this.handles.isGone(operation["pin"])) {
				return false;
			}

			const result = await client.requestAsync(
				this.handles.translate(operation),
				Math.max(1, deadline - this.clock.now()),
			);
			return this.handles.remember(operation, result);
		} catch (err) {
			if (!isHelperChannelLoss(err)) {
				throw err;
			}

			return this.lostResultAsync(client, operation, deadline, err);
		}
	}

	public unavailable(error: Error): void {
		this.failure = error;
		this.client?.dispose?.();
		this.changed("unavailable");
	}

	private changed(state: StudioControl): void {
		this.state = state;
		for (const listener of this.listeners) {
			listener(state);
		}
	}

	private async ensureAsync(): Promise<void> {
		if (this.failure !== undefined) {
			throw this.failure;
		}

		if (this.flight !== undefined) {
			return this.flight;
		}

		if (this.client === undefined) {
			this.flight = this.initializeAsync().finally(() => {
				this.flight = undefined;
			});
			await this.flight;
		}
	}

	private async initializeAsync(): Promise<void> {
		try {
			const current = this.connect();
			this.client = current;
			const identity = await current.identity;
			this.hostname = identity.hostname;
			current.onFailure?.((error) => {
				this.lost(current, error);
			});
		} catch (err) {
			assert(err instanceof Error);
			if (isHelperChannelLoss(err)) {
				this.changed("recovering");
				await this.recoverAsync();
				return;
			}

			this.unavailable(err);
			throw err;
		}
	}

	private lost(client: HelperClient, error: Error): void {
		if (client !== this.client || this.flight !== undefined || this.failure !== undefined) {
			return;
		}

		if (!isHelperChannelLoss(error)) {
			this.failure = error;
			this.changed("unavailable");
			return;
		}

		if (this.clock.now() - this.readyAt >= RESET_MS) {
			this.attempts = 0;
		}

		this.changed("recovering");
		this.flight = this.recoverAsync().finally(() => {
			this.flight = undefined;
		});
		void this.flight.catch(() => {
			/* Failure is retained for the next command. */
		});
	}

	private async lostResultAsync(
		client: HelperClient,
		operation: Record<string, unknown>,
		deadline: number,
		error: Error,
	): Promise<unknown> {
		this.lost(client, error);
		try {
			await this.withinAsync(this.ensureAsync(), Math.max(1, deadline - this.clock.now()));
		} catch {
			throw error;
		}

		const remaining = deadline - this.clock.now();
		if (remaining <= 0) {
			throw error;
		}

		if (reads.has(String(operation["op"]))) {
			return this.requestAsync(operation, remaining);
		}

		return this.proveMutationAsync(operation, remaining, error);
	}

	private async proveMutationAsync(
		operation: Record<string, unknown>,
		remaining: number,
		error: Error,
	): Promise<unknown> {
		const { pin } = operation;
		if (operation["op"] === "setWindowVisibility") {
			const visibility = await this.requestAsync({ op: "windowVisibility", pin }, remaining);
			const expected =
				operation["visibility"] === "active" ? "user" : operation["visibility"];
			if (visibility === expected) {
				return true;
			}
		}

		if (
			operation["op"] === "requestClose" &&
			(await this.requestAsync({ op: "isAlive", pin }, remaining)) === false
		) {
			return true;
		}

		throw error;
	}

	private async recoverAsync(): Promise<void> {
		let last = new Error("Windows helper recovery exhausted.");
		while (this.attempts < ATTEMPTS) {
			this.attempts += 1;
			await this.clock.sleep(BACKOFF_MS * this.attempts);
			let next: HelperClient | undefined;
			try {
				next = this.connect();
				await this.withinAsync(this.restoreAsync(next), ATTEMPT_MS);

				this.client = next;
				next.onFailure?.((error) => {
					assert(next !== undefined);
					this.lost(next, error);
				});
				this.readyAt = this.clock.now();
				this.changed("ready");
				return;
			} catch (err) {
				next?.dispose?.();
				assert(err instanceof Error);
				last = err;
				if (!isHelperChannelLoss(err)) {
					break;
				}
			}
		}

		this.failure = last;
		this.changed("unavailable");
		throw last;
	}

	private async restoreAsync(next: HelperClient): Promise<void> {
		const deadline = this.clock.now() + ATTEMPT_MS;
		const identity = await this.withinAsync(next.identity, ATTEMPT_MS);
		this.hostname ??= identity.hostname;
		if (identity.hostname.toLowerCase() !== this.hostname.toLowerCase()) {
			throw new ForgeError(
				"windows_helper_unavailable",
				"Windows helper host changed during recovery.",
			);
		}

		await this.handles.restoreAsync(next, deadline);
	}

	private async withinAsync<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
		const abort = new AbortController();
		const timeout = this.clock.sleep(timeoutMs, abort.signal).then(() => {
			throw new Error("Windows helper recovery deadline elapsed.");
		});
		try {
			return await Promise.race([work, timeout]);
		} finally {
			abort.abort();
		}
	}
}
