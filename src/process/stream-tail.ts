import type { Readable } from "node:stream";

/** How much of a stream's end {@link keepTail} keeps. */
const TAIL_LENGTH = 2000;

/**
 * Keep the last {@link TAIL_LENGTH} characters a stream wrote, such as a
 * child's stderr for an error message.
 *
 * @param stream - The stream; read as UTF-8 from now on.
 * @returns Reads the tail so far, trimmed.
 */
export function keepTail(stream: Readable): () => string {
	let text = "";
	stream.setEncoding("utf8");
	stream.on("data", (chunk: string) => {
		text = `${text}${chunk}`.slice(-TAIL_LENGTH);
	});
	return () => text.trim();
}
