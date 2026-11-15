import { fromAny } from "@total-typescript/shoehorn";

import { type } from "arktype";
import { EventEmitter } from "node:events";
import { Socket } from "node:net";
import { PassThrough } from "node:stream";
import { assert, describe, it, vi } from "vitest";

import { createFakeSpawner } from "../../test/helpers/fake-process.ts";
import { createTestSeams } from "../../test/helpers/seams.ts";
import type { Clock } from "../seams/clock.ts";
import { nodeClock } from "../seams/clock.ts";
import { createHelperClient } from "./helper-client.ts";

const requestShape = type({ id: "string", deadlineMs: "number", op: "string" });
const IDENTITY = { helperArch: "x64", hostname: "WINDOWS", protocol: 1, windowsArch: "x64" };

function channel(reply: (op: string) => unknown, clock: Clock = nodeClock) {
	const packets: Array<unknown> = [];
	const spawner = createFakeSpawner((child) => {
		child.stdin.setEncoding("utf8");
		child.stdin.on("data", (line: string) => {
			const request = requestShape.assert(JSON.parse(line));
			packets.push(request);
			if (request.op === "handshake") {
				child.stdout.write(`${JSON.stringify({ id: request.id, result: IDENTITY })}\n`);
				return;
			}

			const result = reply(request.op);
			if (result !== undefined && !child.stdout.destroyed && !child.stdout.writableEnded) {
				child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
			}
		});
	});
	const seams = createTestSeams();
	const client = createHelperClient(
		{ ...seams, childProcess: spawner.runner, clock },
		() => ({ args: [], file: "/helper.exe" }),
		"x64",
	);
	return { client, packets, spawner };
}

describe("windows helper channel", () => {
	it("returns the Windows identity and correlated results", async ({ expect }) => {
		expect.assertions(2);

		const { client } = channel(() => true);

		await expect(client.identity).resolves.toEqual(IDENTITY);
		await expect(client.requestAsync({ op: "isAlive", pin: "1" })).resolves.toBe(true);
	});

	it("does not replay a launch after its reply is lost", async ({ expect }) => {
		expect.assertions(2);

		const { client, spawner } = channel(() => true);
		await client.identity;
		const launch = client.requestAsync({ op: "launch" });
		spawner.children[0]!.stdout.end();

		await expect(launch).rejects.toMatchObject({ code: "studio_launch_unknown", exitCode: 1 });
		await expect(client.requestAsync({ op: "isAlive" })).rejects.toThrow("Windows helper EOF.");
	});

	it.for(["stdin", "stdout", "exit", "spawn"] as const)(
		"rejects channel loss on %s",
		async (event, { expect }) => {
			expect.assertions(2);

			const { client } = brokenChannel(event);
			const pending = client.requestAsync({ op: "launch" });

			await expect(pending).rejects.toMatchObject({ code: "studio_launch_unknown" });
			await expect(client.requestAsync({ op: "pin", pid: 707 })).rejects.toThrow();
		},
	);

	it.for([
		"not json",
		'{"id":"2"}',
		'{"id":"2","result":true,"error":{"code":"x","message":"bad"}}',
		'{"id":"unexpected","result":true}',
		"x".repeat(1024 * 1024 + 1),
	])("rejects malformed helper data", async (packet, { expect }) => {
		expect.assertions(1);

		const { client, spawner } = channel(() => {
			const child = spawner.children[0];
			assert(child !== undefined);
			child.stdout.write(`${packet}\n`);
			return true;
		});

		await expect(client.requestAsync({ op: "launch" })).rejects.toMatchObject({
			code: "studio_launch_unknown",
		});
	});

	it("preserves a definite helper operation failure", async ({ expect }) => {
		expect.assertions(1);

		const { client, spawner } = channel(() => {
			const child = spawner.children[0];
			assert(child !== undefined);
			child.stdout.write(
				'{"id":"2","error":{"code":"operation_failed","message":"launch refused"}}\n',
			);
			return true;
		});

		await expect(client.requestAsync({ op: "launch" })).rejects.toMatchObject({
			code: "windows_helper_unavailable",
			message: "launch refused",
		});
	});

	it("bounds a lost reply by its request deadline", async ({ expect }) => {
		expect.assertions(1);

		let expire: (() => void) | undefined;
		const clock: Clock = {
			now: () => 1000,
			sleep: async (_ms, signal) => {
				return new Promise<void>((resolve, reject) => {
					expire = resolve;
					signal!.addEventListener("abort", () => {
						reject(new Error("aborted"));
					});
				});
			},
		};
		const { client } = channel(() => {
			queueMicrotask(() => {
				assert(expire !== undefined);
				expire();
			});
		}, clock);

		await expect(client.requestAsync({ op: "launch" })).rejects.toMatchObject({
			code: "studio_launch_unknown",
		});
	});

	it("handles a synchronous pipe write failure", async ({ expect }) => {
		expect.assertions(1);

		const { client, spawner } = channel(() => true);
		await client.identity;
		const child = spawner.children[0];
		assert(child !== undefined);
		vi.spyOn(child.stdin, "write").mockThrow(new Error("pipe failed"));

		await expect(client.requestAsync({ op: "launch" })).rejects.toMatchObject({
			code: "studio_launch_unknown",
		});
	});

	it("rejects a relative helper executable before starting it", ({ expect }) => {
		expect.assertions(1);
		expect(() => {
			return createHelperClient(
				createTestSeams(),
				() => ({ args: [], file: "helper.exe" }),
				"x64",
			);
		}).toThrow("must be absolute");
	});

	it("handles an asynchronous EPIPE from the write callback", async ({ expect }) => {
		expect.assertions(1);

		const { client, spawner } = channel(() => true);
		await client.identity;
		const child = spawner.children[0];
		assert(child !== undefined);
		child.stdin.destroy();

		await expect(client.requestAsync({ op: "launch" })).rejects.toMatchObject({
			code: "studio_launch_unknown",
		});
	});

	it("allows an idle helper with Node pipe sockets to leave the event loop", async ({
		expect,
	}) => {
		expect.assertions(4);

		const decoder = new TextDecoder();
		const stdin = new PassThrough();
		const stdout = new TrackingSocket();
		const stderr = new TrackingSocket();
		const child = Object.assign(new EventEmitter(), {
			kill: () => true,
			stderr,
			stdin,
			stdout,
			unref: () => {
				// The fake process has no event loop reference.
			},
		});
		stdin.on("data", (line: Uint8Array) => {
			const request = requestShape.assert(JSON.parse(decoder.decode(line)));
			stdout.emit("data", `${JSON.stringify({ id: request.id, result: IDENTITY })}\n`);
		});
		const client = createHelperClient(
			{ childProcess: { spawn: fromAny(() => child) }, clock: nodeClock },
			() => ({ args: [], file: "/helper.exe" }),
			"x64",
		);

		await expect(client.identity).resolves.toEqual(IDENTITY);
		expect(stdout.isReferenced).toBe(false);
		expect(stderr.isReferenced).toBe(false);
		expect(stderr.readableFlowing).toBe(true);
	});

	it("sends versioned requests with ids, deadlines and hidden stdio", async ({ expect }) => {
		expect.assertions(3);

		const { client, packets, spawner } = channel(() => true, { ...nodeClock, now: () => 1000 });
		await client.requestAsync({ op: "isAlive", pin: "held" });

		expect(packets).toEqual([
			{ id: "1", deadlineMs: 11000, op: "handshake", protocol: 1 },
			{ id: "2", deadlineMs: 11000, op: "isAlive", pin: "held" },
		]);
		expect(spawner.calls).toEqual([
			{
				args: [],
				file: "/helper.exe",
				options: { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
			},
		]);
		expect(spawner.children[0]!.referenced).toBe(false);
	});

	it("releases its helper resources once after channel loss", async ({ expect }) => {
		expect.assertions(5);

		const { client, spawner } = brokenChannel("stdin");

		await expect(client.requestAsync({ op: "launch" })).rejects.toMatchObject({
			cause: { code: "EPIPE" },
			code: "studio_launch_unknown",
			message: "The Studio launch reply was lost. Check Studio before trying again.",
		});

		const child = spawner.children[0];
		assert(child !== undefined);

		expect(child.stdin.destroyed).toBe(true);
		expect(child.stdout.destroyed).toBe(true);
		expect(child.stderr.destroyed).toBe(true);

		await new Promise<void>((resolve) => {
			setImmediate(resolve);
		});

		expect(child.kills).toHaveLength(1);
	});

	it.for(["stdin", "stdout", "exit", "spawn"] as const)(
		"explains the original %s channel failure",
		async (event, { expect }) => {
			expect.assertions(1);

			const { client } = brokenChannel(event);

			await expect(client.requestAsync({ op: "isAlive" })).rejects.toThrow(
				channelMessage(event),
			);
		},
	);

	it("explains a request deadline failure", async ({ expect }) => {
		expect.assertions(1);

		let expire: (() => void) | undefined;
		const clock: Clock = {
			now: () => 1000,
			sleep: async (_ms, signal) => {
				return new Promise<void>((resolve, reject) => {
					expire = resolve;
					signal!.addEventListener("abort", () => {
						reject(new Error("aborted"));
					});
				});
			},
		};
		const { client } = channel(() => {
			queueMicrotask(() => {
				assert(expire !== undefined);
				expire();
			});
		}, clock);

		await expect(client.requestAsync({ op: "isAlive" })).rejects.toThrow(
			"Windows helper request deadline elapsed.",
		);
	});

	it.for([
		['{"id":"2"}', "Malformed Windows helper reply."],
		['{"id":"other","result":true}', "Unknown Windows helper reply id."],
		["x".repeat(1024 * 1024 + 1), "Windows helper reply exceeds 1 MiB."],
	])("explains invalid helper frames", async ([packet, message], { expect }) => {
		expect.assertions(1);

		const { client, spawner } = channel(() => {
			const child = spawner.children[0];
			assert(child !== undefined);
			child.stdout.write(`${packet}\n`);
		});

		await expect(client.requestAsync({ op: "isAlive" })).rejects.toThrow(message);
	});

	it("accepts a complete frame at the byte limit and consumes it before the next", async ({
		expect,
	}) => {
		expect.assertions(2);

		const { client, spawner } = channel(() => {
			const child = spawner.children[0];
			assert(child !== undefined);
			child.stdout.write(`{"id":"2","result":true}${" ".repeat(1024 * 1024 - 25)}\n`);
		});

		await expect(client.requestAsync({ op: "isAlive" })).resolves.toBe(true);
		await expect(client.requestAsync({ op: "isAlive" })).rejects.toThrow(
			"Unknown Windows helper reply id.",
		);
	});

	it("cancels request deadlines after replies arrive", async ({ expect }) => {
		expect.assertions(1);

		const signals: Array<AbortSignal | undefined> = [];
		const clock: Clock = {
			now: () => 1000,
			sleep: async (ms, signal) => {
				signals.push(signal);
				await nodeClock.sleep(ms, signal);
			},
		};
		const { client } = channel(() => true, clock);
		await client.requestAsync({ op: "isAlive" });

		expect(signals.map((signal) => signal!.aborted)).toEqual([true, true]);
	});

	it("correlates two replies delivered in the same NDJSON chunk", async ({ expect }) => {
		expect.assertions(1);

		const { client } = batchedChannel();

		await expect(
			Promise.all([
				client.requestAsync({ op: "first" }),
				client.requestAsync({ op: "second" }),
			]),
		).resolves.toEqual([true, false]);
	});
});

class TrackingSocket extends Socket {
	public isReferenced = true;

	public override unref(): this {
		this.isReferenced = false;
		return this;
	}
}

function brokenChannel(event: "exit" | "spawn" | "stdin" | "stdout") {
	const { client, spawner } = channel(() => {
		const child = spawner.children[0];
		assert(child !== undefined);
		const failure = Object.assign(new Error("broken channel"), { code: "EPIPE" });
		queueMicrotask(() => {
			switch (event) {
				case "exit": {
					child.exit(1);
					break;
				}
				case "spawn": {
					child.error(failure);
					break;
				}
				case "stdin": {
					child.stdin.emit("error", failure);
					break;
				}
				case "stdout": {
					child.stdout.emit("error", failure);
					break;
				}
			}
		});
	});
	return { client, spawner };
}

function channelMessage(event: "exit" | "spawn" | "stdin" | "stdout"): string {
	switch (event) {
		case "exit": {
			return "Windows helper exited.";
		}
		case "spawn": {
			return "Could not start the Windows helper channel: broken channel";
		}
		case "stdin":
		case "stdout": {
			return "broken channel";
		}
	}
}

function batchedChannel() {
	let count = 0;
	const { client, spawner } = channel(() => {
		count += 1;
		if (count === 2) {
			const child = spawner.children[0];
			assert(child !== undefined);
			child.stdout.write('{"id":"2","result":true}\n{"id":"3","result":false}\n');
		}
	});
	return { client };
}
