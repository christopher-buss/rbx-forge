import { encode } from "@msgpack/msgpack";

import { Buffer } from "node:buffer";
import path from "node:path";
import { assert, describe, it, vi } from "vitest";

import { createFakeCapture } from "../../test/helpers/fake-capture.ts";
import { createHelperProbe } from "../../test/helpers/helper-probe.ts";
import {
	createCommandContext,
	createMemoryFileSystem,
	createTestSeams,
	PROJECT,
} from "../../test/helpers/seams.ts";
import { resolveConfig } from "../config/resolve.ts";
import type { Seams } from "../seams/seams.ts";
import { waitForRojoAsync } from "./rojo-part.ts";

const INFO = {
	projectName: "Game",
	protocolVersion: 5,
	serverVersion: "7.7.1",
	sessionId: "session",
};

function readiness(seams: Seams, controller: AbortController) {
	const service = vi.fn<() => void>();
	const pending = waitForRojoAsync(
		{ context: createCommandContext({ seams }), status: { rojoPort: () => {}, service } },
		{ signal: controller.signal, track: () => {} },
		{ stop: () => {} },
		{ part: { stopped: new Promise<void>(() => {}) }, port: 34872 },
	);
	return { pending, service };
}

function fixture(mode: string) {
	const controller = new AbortController();
	const seams = createTestSeams();
	seams.network.isListeningAsync = async () => true;
	seams.network.getRojoInfoAsync = async () => INFO;
	const replies = new Map([
		[
			"canceled",
			async () => {
				controller.abort(new Error("canceled"));
				return encode(INFO);
			},
		],
		[
			"canceledFailure",
			async (): Promise<Uint8Array> => {
				controller.abort(new Error("canceled"));
				throw new Error("connection refused");
			},
		],
		["invalid", async () => new Uint8Array([193])],
		["project", async () => encode({ ...INFO, projectName: "other" })],
		["protocol", async () => encode({ ...INFO, protocolVersion: 4 })],
		["reachable", async () => encode(INFO)],
		["session", async () => encode({ ...INFO, sessionId: "other" })],
		[
			"unreachable",
			async (): Promise<Uint8Array> => {
				throw new Error("refused");
			},
		],
		["version", async () => encode({ ...INFO, serverVersion: "7.6.0" })],
	]);
	const reply = replies.get(mode);
	assert(reply !== undefined);
	seams.studioHost.probeHttpAsync = createHelperProbe(async (route) => {
		assert(route === "/api/rojo");
		return reply();
	});

	return readiness(seams, controller);
}

function helperFixture(launch?: string) {
	const seams = createTestSeams();
	seams.network.isListeningAsync = async () => true;
	seams.network.getRojoInfoAsync = async () => INFO;
	seams.studioHost.probeHttpAsync = createHelperProbe(async () => {
		throw new Error("connection refused");
	}, launch);
	return readiness(seams, new AbortController());
}

describe("windows reachability before Rojo readiness", () => {
	it("does not publish ready when canceled during the Windows probe", async ({ expect }) => {
		expect.assertions(2);

		const { pending, service } = fixture("canceled");

		await expect(pending).rejects.toThrow("canceled");
		expect(service).not.toHaveBeenCalled();
	});

	it("explains how to repair unreachable Windows networking", async ({ expect }) => {
		expect.assertions(1);

		const { pending } = fixture("project");

		await expect(pending).rejects.toMatchObject({
			cause: { message: "Windows reached a different Rojo identity." },
			hint: "Check WSL localhost forwarding, the networking mode (NAT or mirrored), and the Windows firewall.",
			message: "Windows cannot reach the WSL session on IPv4 loopback.",
		});
	});

	it("keeps the session capture URL unpublished when Windows cannot reach it", async ({
		expect,
	}) => {
		expect.assertions(3);

		const memory = createMemoryFileSystem({
			"default.project.json": '{"name":"Game"}',
			"session/rojo.project.json": "inert",
		});
		const seams = createTestSeams({ fileSystem: memory.fileSystem });
		const listener = createFakeCapture({ model: new Uint8Array(), services: [] });
		seams.randomId = () => "nonce";
		seams.network.isListeningAsync = async () => true;
		seams.network.getRojoInfoAsync = async () => INFO;
		seams.network.listenForCaptureAsync = async () => listener;
		const replies = new Map([
			["/api/rojo", encode(INFO)],
			[
				"/capture/test/probe/nonce?projectName=project&sessionId=session",
				Buffer.from("wrong"),
			],
		]);
		seams.studioHost.probeHttpAsync = async (_port, route) => {
			const response = replies.get(route);
			assert(response !== undefined);
			return response;
		};

		const service = vi.fn<() => void>();
		const pending = waitForRojoAsync(
			{
				config: resolveConfig(
					{ projectType: "luau", studio: { saveMethod: "capture" } },
					{},
				),
				context: createCommandContext({ seams }),
				directory: path.join(PROJECT, "session"),
				status: { rojoPort: () => {}, service },
			},
			{ signal: AbortSignal.timeout(10000), track: () => {} },
			{ stop: () => {} },
			{ part: { stopped: new Promise<void>(() => {}) }, port: 34872 },
		);

		await expect(pending).rejects.toMatchObject({ code: "wsl_network_unreachable" });
		expect(memory.files()["session/rojo.project.json"]).toBe("inert");
		expect(service).not.toHaveBeenCalled();
	});

	it.for(["unreachable", "invalid", "project", "session", "protocol", "version"])(
		"rejects %s Windows identity",
		async (mode, { expect }) => {
			expect.assertions(2);

			const { pending, service } = fixture(mode);

			await expect(pending).rejects.toMatchObject({
				code: "wsl_network_unreachable",
				exitCode: 1,
			});
			expect(service).not.toHaveBeenCalled();
		},
	);

	it("reports a probe the Windows helper ran and failed as unreachable networking", async ({
		expect,
	}) => {
		expect.assertions(2);

		const { pending, service } = helperFixture(undefined);

		await expect(pending).rejects.toMatchObject({
			cause: { message: "connection refused" },
			code: "wsl_network_unreachable",
		});
		expect(service).not.toHaveBeenCalled();
	});

	it.for([
		{ code: "windows_helper_unavailable", launch: "ENOENT" },
		{ code: "wsl_interop_unavailable", launch: "EIO" },
	])(
		"keeps a $launch helper start failure as $code, not a network failure",
		async ({ code, launch }, { expect }) => {
			expect.assertions(2);

			const { pending, service } = helperFixture(launch);

			await expect(pending).rejects.toMatchObject({ code });
			expect(service).not.toHaveBeenCalled();
		},
	);

	it("keeps cancellation while the Windows helper fails the probe", async ({ expect }) => {
		expect.assertions(2);

		const { pending, service } = fixture("canceledFailure");

		await expect(pending).rejects.toThrow("canceled");
		expect(service).not.toHaveBeenCalled();
	});

	it.for([
		{
			name: "unreachable",
			cancel: (_controller: AbortController) => {},
			expected: { code: "wsl_network_unreachable" },
		},
		{
			name: "canceled",
			cancel: (controller: AbortController) => {
				controller.abort(new Error("canceled"));
			},
			expected: { message: "canceled" },
		},
	])(
		"keeps a $name failed Rojo identity read before the Windows probe",
		async ({ cancel, expected }, { expect }) => {
			expect.assertions(1);

			const controller = new AbortController();
			const seams = createTestSeams();
			seams.network.isListeningAsync = async () => true;
			seams.network.getRojoInfoAsync = async () => {
				cancel(controller);
				throw new Error("Rojo server info returned HTTP 503.");
			};

			seams.studioHost.probeHttpAsync = createHelperProbe(async () => encode(INFO));

			await expect(readiness(seams, controller).pending).rejects.toMatchObject(expected);
		},
	);

	it("publishes ready after Windows verifies the identity", async ({ expect }) => {
		expect.assertions(2);

		const { pending, service } = fixture("reachable");

		await expect(pending).resolves.toBe(true);
		expect(service).toHaveBeenCalledWith("rojo", "ready");
	});
});
