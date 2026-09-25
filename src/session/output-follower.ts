import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { StringDecoder } from "node:string_decoder";

import type { FileSystem } from "../seams/file-system.ts";

/**
 * Reads a worker's output file as the worker writes it. The reaper appends a
 * worker's stdout and stderr to one file; the host reads it from where it
 * stopped, so each line reaches the rotated log and any parser once.
 */
export interface OutputFollower {
	/** Read the rest, and hand over a last line that has no newline. */
	finish: () => void;
	/** Read what arrived since the last read; hand over each whole line. */
	read: () => void;
}

/** Where one follower stands in its file. */
interface FollowState {
	decoder: StringDecoder;
	file: string;
	fileSystem: FileSystem;
	/** Bytes read so far. */
	offset: number;
	onLine: (line: string) => void;
	/** The text after the last line break read. */
	partial: string;
}

const CHUNK_BYTES = 65_536;
const TRAILING_CR = /\r$/;

/**
 * Follow one output file. A file that does not exist yet reads as empty.
 *
 * @param fileSystem - Reads the file.
 * @param file - The worker's output file.
 * @param onLine - Gets each line, without its line break.
 * @returns The follower.
 */
export function followOutput(
	fileSystem: FileSystem,
	file: string,
	onLine: (line: string) => void,
): OutputFollower {
	const state: FollowState = {
		decoder: new StringDecoder("utf8"),
		file,
		fileSystem,
		offset: 0,
		onLine,
		partial: "",
	};

	return {
		finish: () => {
			read(state);
			take(state, state.decoder.end());
			if (state.partial !== "") {
				take(state, "\n");
			}
		},
		read: () => {
			read(state);
		},
	};
}

/**
 * Add decoded text: hand over each line it completes, keep the rest.
 *
 * @param state - The follower.
 * @param text - Text as read; it may end mid-line.
 */
function take(state: FollowState, text: string): void {
	const parts = `${state.partial}${text}`.split("\n");
	const rest = parts.pop();
	// `split` always returns at least one part.
	assert(rest !== undefined);
	state.partial = rest;
	for (const line of parts) {
		state.onLine(line.replace(TRAILING_CR, ""));
	}
}

function read(state: FollowState): void {
	const { file, fileSystem } = state;
	if (!fileSystem.existsSync(file)) {
		return;
	}

	const buffer = Buffer.alloc(CHUNK_BYTES);
	const descriptor = fileSystem.openSync(file, "r");
	try {
		let bytes = fileSystem.readSync(descriptor, buffer, 0, CHUNK_BYTES, state.offset);
		while (bytes > 0) {
			state.offset += bytes;
			take(state, state.decoder.write(buffer.subarray(0, bytes)));
			bytes = fileSystem.readSync(descriptor, buffer, 0, CHUNK_BYTES, state.offset);
		}
	} finally {
		fileSystem.closeSync(descriptor);
	}
}
