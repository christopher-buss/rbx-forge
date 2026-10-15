import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { gunzipSync } from "node:zlib";

import type { NativeAddon, PinnedProcess } from "../../src/native/addon.ts";

const CAPTURE_ROUTE = /\/capture\/[^?]+/u;

/** A report from the test plugin in the explicitly owned Studio. */
export interface CaptureStudioObservation {
	captureCount: number;
	captureInstances: string;
	captureUrl: string;
	completed: string;
	connectedSessionId: string;
	connection: string;
	error: string;
	sequence: number;
	version: string;
}

/** Controls stay inert until an owned, token-marked Studio has been pinned. */
export interface CaptureStudioFixture {
	closeAsync: () => Promise<void>;
	launchAttributes: Record<string, string>;
	own: (studio: PinnedProcess) => void;
	runAsync: (action: string) => Promise<CaptureStudioObservation>;
	sample: () => CaptureStudioObservation | undefined;
	waitForCaptureUrlAsync: (previous?: string) => Promise<CaptureStudioObservation>;
	waitForDisconnectedAsync: () => Promise<CaptureStudioObservation>;
}

interface Runtime {
	command: undefined | { action: string; id: string };
	observation: CaptureStudioObservation | undefined;
	studio: PinnedProcess | undefined;
}

/**
 * Install one token-gated editing plugin alongside the managed plugins.
 *
 * @param options - A unique fixture directory, genuine addon and real Plugins folder.
 * @returns Controls for this fixture's launched and pinned Studio only.
 * @rejects When the listener or isolated plugin cannot be created.
 */
export async function captureRealStudioFixtureAsync({
	actions,
	captureName = "ForgeCapture",
	directory,
	native,
	pluginsDirectory,
}: {
	actions: Record<string, string>;
	captureName?: string;
	directory: string;
	native: NativeAddon;
	pluginsDirectory: string;
}): Promise<CaptureStudioFixture> {
	const token = randomBytes(32).toString("hex");
	const runtime: Runtime = { command: undefined, observation: undefined, studio: undefined };
	const server = captureServer(runtime, token);
	const url = await listenAsync(server, token);
	const plugin = path.join(pluginsDirectory, `ForgeCaptureTest-${token}.rbxm`);
	try {
		installModel({ actions, captureName, directory, native, plugin, token, url });
	} catch (err) {
		await closeServerAsync(server);
		rmSync(plugin, { force: true });
		throw err;
	}

	return controls(runtime, { actions, plugin, server, token });
}

function captureServer(runtime: Runtime, token: string): Server {
	return createServer((request, response) => {
		const url = new URL(request.url ?? "", "http://127.0.0.1");
		if (request.method !== "GET" || url.pathname !== `/${token}`) {
			response.writeHead(404).end();
			return;
		}

		runtime.observation = {
			captureCount: Number(url.searchParams.get("captureCount")),
			captureInstances: url.searchParams.get("captureInstances") ?? "[]",
			captureUrl: url.searchParams.get("captureUrl") ?? "",
			completed: url.searchParams.get("completed") ?? "",
			connectedSessionId: url.searchParams.get("connectedSessionId") ?? "",
			connection: url.searchParams.get("connection") ?? "",
			error: url.searchParams.get("error") ?? "",
			sequence: Number(url.searchParams.get("sequence")),
			version: url.searchParams.get("version") ?? "",
		};
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify(runtime.command ?? {}));
	});
}

async function closeServerAsync(server: Server): Promise<void> {
	server.closeAllConnections();
	await new Promise<void>((resolve, reject) => {
		server.close((error) => {
			if (error === undefined) {
				resolve();
			} else {
				reject(error);
			}
		});
	});
}

function redactedObservation(observation: CaptureStudioObservation | undefined): unknown {
	return observation === undefined
		? undefined
		: {
				...observation,
				captureUrl: observation.captureUrl.replace(CAPTURE_ROUTE, "/capture/<secret>"),
			};
}

async function waitForAsync(
	runtime: Runtime,
	ready: (entry: CaptureStudioObservation) => boolean,
	description: string,
): Promise<CaptureStudioObservation> {
	const deadline = Date.now() + 90_000;
	for (;;) {
		assert(runtime.studio?.isAlive() === true, "Only a pinned, living Studio may be edited");
		if (runtime.observation !== undefined && ready(runtime.observation)) {
			return runtime.observation;
		}

		assert(
			Date.now() < deadline,
			`Timed out waiting for Studio ${description}: ${JSON.stringify(redactedObservation(runtime.observation))}`,
		);
		await sleep(100);
	}
}

async function runActionAsync(
	runtime: Runtime,
	actions: Record<string, string>,
	action: string,
): Promise<CaptureStudioObservation> {
	assert(Object.hasOwn(actions, action), `Unknown Studio edit: ${action}`);
	assert(runtime.command === undefined, "Studio edits run one at a time");
	await waitForAsync(runtime, (entry) => entry.captureUrl !== "", "capture connection");
	const id = randomBytes(16).toString("hex");
	runtime.command = { id, action };
	try {
		const result = await waitForAsync(runtime, (entry) => entry.completed === id, action);
		assert.equal(result.error, "", `Studio edit ${action} failed`);
		return result;
	} finally {
		runtime.command = undefined;
	}
}

function controls(
	runtime: Runtime,
	{
		actions,
		plugin,
		server,
		token,
	}: {
		actions: Record<string, string>;
		plugin: string;
		server: Server;
		token: string;
	},
): CaptureStudioFixture {
	return {
		closeAsync: async () => {
			await closeServerAsync(server);
			rmSync(plugin, { force: true });
		},
		launchAttributes: { __ForgeCaptureTestLaunch: token },
		own: (studio) => {
			assert(studio.isAlive(), "The launched Studio must still be alive");
			runtime.studio = studio;
		},
		runAsync: async (action) => runActionAsync(runtime, actions, action),
		sample: () => runtime.observation,
		waitForCaptureUrlAsync: async (previous = "") => {
			return waitForAsync(
				runtime,
				(entry) => entry.captureUrl !== "" && entry.captureUrl !== previous,
				"new session capture URL",
			);
		},
		waitForDisconnectedAsync: async () => {
			return waitForAsync(
				runtime,
				(entry) => entry.connectedSessionId === "",
				"Rojo disconnection",
			);
		},
	};
}

function installModel({
	actions,
	captureName,
	directory,
	native,
	plugin,
	token,
	url,
}: {
	actions: Record<string, string>;
	captureName: string;
	directory: string;
	native: NativeAddon;
	plugin: string;
	token: string;
	url: string;
}): void {
	const model = path.join(directory, `capture-editor-${token}.rbxm`);
	writeFileSync(
		model,
		gunzipSync(
			readFileSync(path.join(import.meta.dirname, "../fixtures/models/rojo-7.7.1.rbxm.gz")),
		),
	);
	native.writeModelScriptSources(model, [
		{ path: ["Rojo", "Plugin"], source: pluginSource(actions, captureName, token, url) },
	]);
	mkdirSync(path.dirname(plugin), { recursive: true });
	copyFileSync(model, plugin);
}

async function listenAsync(server: Server, token: string): Promise<string> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert(address !== null && typeof address !== "string");
	return `http://127.0.0.1:${address.port}/${token}`;
}

// cspell:ignore pcall gsub
const EDITOR_SOURCE = `-- This plugin acts only in its token-marked fixture place.
local deadline = os.clock() + 600
local function ownedSnapshot()
	local capture = game:GetService("ServerStorage"):FindFirstChild("ForgeCapture")
	return capture and capture:IsA("Configuration") and not capture.Archivable
		and capture:GetAttribute("Snapshot") == true
end
while game:GetAttribute("__ForgeCaptureTestLaunch") ~= __FORGE_EDITOR_TOKEN__ and not ownedSnapshot() do
	if os.clock() >= deadline then return end
	task.wait(0.1)
end
local HttpService = game:GetService("HttpService")
local actions = {%FORGE_EDITOR_ACTIONS%}
local completed, failure = "", ""
local sequence = 0
while os.clock() < deadline do
	sequence += 1
	local capture = game:GetService("ServerStorage"):FindFirstChild("ForgeCapture")
	local captureUrl = if capture then capture:GetAttribute("CaptureUrl") or "" else ""
	local captures = {}
	for _, child in game:GetService("ServerStorage"):GetChildren() do
		if child.Name == "ForgeCapture" then
			table.insert(captures, {
				projectName = child:GetAttribute("ProjectName") or "",
				sessionId = child:GetAttribute("SessionId") or "",
				connectedSessionId = child:GetAttribute("ConnectedSessionId") or "",
				captureUrl = string.gsub(child:GetAttribute("CaptureUrl") or "", "/capture/[^?]+", "/capture/<secret>"),
				archivable = child.Archivable,
			})
		end
	end
	local query = "?version=" .. HttpService:UrlEncode(version())
		.. "&captureCount=" .. tostring(#captures)
		.. "&captureInstances=" .. HttpService:UrlEncode(HttpService:JSONEncode(captures))
		.. "&captureUrl=" .. HttpService:UrlEncode(captureUrl)
		.. "&connection=" .. HttpService:UrlEncode(workspace:GetAttribute("__Rojo_ConnectionUrl") or "")
		.. "&connectedSessionId=" .. HttpService:UrlEncode(if capture then capture:GetAttribute("ConnectedSessionId") or "" else "")
		.. "&completed=" .. completed
		.. "&sequence=" .. tostring(sequence)
		.. "&error=" .. HttpService:UrlEncode(failure)
	local ok, body = pcall(HttpService.GetAsync, HttpService, __FORGE_EDITOR_URL__ .. query, true)
	if ok then
		local decoded, command = pcall(HttpService.JSONDecode, HttpService, body)
		if decoded and command.id and command.id ~= completed and actions[command.action] then
			local edited, result = pcall(actions[command.action])
			completed = command.id
			failure = if edited then "" else tostring(result)
		end
	end
	task.wait(0.1)
end`;

function pluginSource(
	actions: Record<string, string>,
	captureName: string,
	token: string,
	url: string,
): string {
	const callbacks = Object.entries(actions)
		.map(([name, source]) => `[${JSON.stringify(name)}] = function()\n${source}\nend`)
		.join(",\n");
	return EDITOR_SOURCE.replace("%FORGE_EDITOR_ACTIONS%", () => callbacks)
		.replaceAll('"ForgeCapture"', () => JSON.stringify(captureName))
		.replace("__FORGE_EDITOR_TOKEN__", () => JSON.stringify(token))
		.replace("__FORGE_EDITOR_URL__", () => JSON.stringify(url));
}
