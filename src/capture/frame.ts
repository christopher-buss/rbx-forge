import { type } from "arktype";
import { Buffer } from "node:buffer";
import type { IncomingMessage } from "node:http";

import { ForgeError } from "../errors.ts";
import type { Capture } from "./protocol.ts";
import { captureWarnings } from "./warnings.ts";

const metadataSchema = type({
	"services": type({ name: "string > 0", roots: "number.integer >= 0[]" }).array(),
	"warnings?": captureWarnings,
});
const rejectionSchema = type({
	"error": "'play_mode' | 'busy' | 'serialize_failed' | 'not_connected'",
	"message?": "string",
});
const rejectionMessages = {
	busy: "Studio is busy capturing; wait for that capture to finish.",
	not_connected: "The forge plugin is not connected; connect Studio to the session's Rojo.",
	play_mode: "Studio is in Play mode; stop Play mode before capturing.",
	serialize_failed: "Studio could not serialize the capture; check Studio's Output window.",
};
const MAX_BODY_BYTES = 128 * 1024 * 1024;
export async function readCaptureAsync(incoming: IncomingMessage): Promise<Capture> {
	const body = await readBodyAsync(incoming);
	if (incoming.headers["content-type"] === "application/json") {
		throw studioRejection(body);
	}

	if (body.length < 4) {
		throw new ForgeError("capture_rejected", "The capture frame is incomplete.");
	}

	const size = body.readUInt32LE();
	if (size > body.length - 4) {
		throw new ForgeError("capture_rejected", "The capture metadata is incomplete.");
	}

	const metadata = metadataSchema.assert(JSON.parse(body.subarray(4, 4 + size).toString("utf8")));
	return { ...metadata, model: new Uint8Array(body.subarray(4 + size)) };
}

async function readBodyAsync(incoming: IncomingMessage): Promise<Buffer> {
	const body: AsyncIterable<Buffer | string> = incoming;
	const chunks: Array<Buffer> = [];
	let bytes = 0;
	for await (const chunk of body) {
		const part = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		bytes += part.length;
		if (bytes > MAX_BODY_BYTES) {
			throw new ForgeError("capture_rejected", "The capture exceeds the size limit.");
		}

		chunks.push(part);
	}

	return Buffer.concat(chunks);
}

function studioRejection(body: Buffer): ForgeError {
	const response = body.toString("utf8");
	const { error: reason, message } = rejectionSchema.assert(JSON.parse(response));
	return new ForgeError(
		reason === "not_connected" ? "capture_not_connected" : "capture_rejected",
		rejectionMessages[reason],
		{
			details: { message, reason, response },
		},
	);
}
