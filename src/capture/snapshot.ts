import { type } from "arktype";

import type { CommandContext } from "../commands/context.ts";
import type { ResolvedConfig } from "../config/resolve.ts";
import { ForgeError } from "../errors.ts";
import { findPlaceStudio } from "../studio/close-studio.ts";
import type { StudioSave } from "../studio/save-studio.ts";
import type { CaptureListener } from "./protocol.ts";
import { saveCaptureAsync } from "./save.ts";

const snapshotCapture = type({
	port: "0 < number.integer <= 65535",
	projectName: "string > 0",
	secret: /^[a-f0-9]{64}$/u,
	sessionId: "string > 0",
});

/**
 * Record a snapshot's authenticated endpoint and its non-persisted launch marker.
 * @param context - Files, entropy and the capture listener seam.
 * @param place - The snapshot's absolute path.
 * @returns The launch script passed to the directly started Studio.
 * @rejects Listener binding or file write failure.
 */
export async function prepareSnapshotCaptureAsync(
	{ seams }: CommandContext,
	place: string,
): Promise<string> {
	const identity = { projectName: "snapshot", sessionId: seams.randomId() };
	const listener = await seams.network.listenForCaptureAsync(identity);
	try {
		const url = new URL(listener.url);
		const secret = url.pathname.slice("/capture/".length);
		seams.fileSystem.writeFileSync(
			`${place}.capture.json`,
			JSON.stringify({ ...identity, port: Number(url.port), secret }),
			{ mode: 0o600 },
		);
		const runScript = `${place}.capture.lua`;
		seams.fileSystem.writeFileSync(
			runScript,
			snapshotMarker({
				CaptureUrl: listener.url,
				ProjectName: identity.projectName,
				SessionId: identity.sessionId,
				Snapshot: true,
			}),
			{ mode: 0o600 },
		);
		return runScript;
	} finally {
		listener.close();
	}
}

/**
 * Capture a verified snapshot Studio on the endpoint recorded when it opened.
 * @param context - The project, files, network and native seams.
 * @param config - The current syncback base project.
 * @param place - The requested snapshot, always the capture destination.
 * @param timeoutMs - The complete build and capture deadline.
 * @returns The atomically written snapshot's metadata.
 * @rejects An invalid snapshot marker, an unverified Studio, or a capture failure.
 */
export async function saveSnapshotCaptureAsync(
	context: CommandContext,
	config: ResolvedConfig,
	place: string,
	timeoutMs: number,
): Promise<StudioSave> {
	const { seams } = context;
	const studio = findPlaceStudio(seams, place);
	if (studio === undefined) {
		throw new ForgeError("studio_not_open", `Roblox Studio does not have ${place} open.`);
	}

	const endpoint = readSnapshotCapture(context, place);
	const signal = AbortSignal.timeout(timeoutMs);
	const deadline = seams.clock.now() + timeoutMs;
	const listener = await bindSnapshotAsync(context, endpoint, signal);
	try {
		return await saveCaptureAsync(
			context,
			{ ...config, syncback: { ...config.syncback, inputPath: place } },
			{ deadline, listener, signal, studio: { ...studio, place } },
		);
	} finally {
		listener.close();
	}
}

function snapshotMarker(attributes: Record<string, boolean | string>): string {
	const setters = Object.entries(attributes)
		.map(([name, value]) => `m:SetAttribute(${JSON.stringify(name)},${JSON.stringify(value)});`)
		.join("");
	return `local m=Instance.new("Configuration");m.Name="ForgeCapture";m.Archivable=false;${setters}m.Parent=game:GetService("ServerStorage")\n`;
}

async function bindSnapshotAsync(
	{ seams }: CommandContext,
	endpoint: typeof snapshotCapture.infer,
	signal: AbortSignal,
): Promise<CaptureListener> {
	try {
		return await seams.network.listenForCaptureAsync(
			{ projectName: endpoint.projectName, sessionId: endpoint.sessionId },
			signal,
			{ port: endpoint.port, secret: endpoint.secret },
		);
	} catch (err) {
		if (err instanceof Error && "code" in err && err.code === "EADDRINUSE") {
			throw new ForgeError(
				"capture_port_in_use",
				`Snapshot capture port ${endpoint.port} is occupied.`,
				{ cause: err, hint: "Release the port or open a new snapshot." },
			);
		}

		throw err;
	}
}

function readSnapshotCapture(
	{ seams }: CommandContext,
	place: string,
): typeof snapshotCapture.infer {
	try {
		return snapshotCapture.assert(
			JSON.parse(seams.fileSystem.readFileSync(`${place}.capture.json`, "utf8")),
		);
	} catch (err) {
		throw new ForgeError(
			"capture_not_connected",
			"This snapshot has no valid capture marker.",
			{
				cause: err,
				hint: 'Open a new snapshot with studio.saveMethod set to "capture".',
			},
		);
	}
}
