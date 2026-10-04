import { gunzipSync, gzipSync } from "node:zlib";

const BLOCK = 512;
const DECODER = new TextDecoder();
const ENCODER = new TextEncoder();

export interface TarEntry {
	readonly name: string;
	/** The ustar prefix field, for a path split in two. */
	readonly prefix?: string;
	readonly size: number;
}

/**
 * A gzipped ustar tarball whose files are 0644, as a Windows pack writes them.
 *
 * @param entries - The files, in order.
 * @returns The `.tgz` contents.
 */
export function gzippedTarball(entries: ReadonlyArray<TarEntry>): Uint8Array {
	const blocks = entries.flatMap(({ name, prefix = "", size }) => {
		const body = new Uint8Array(Math.ceil(size / BLOCK) * BLOCK);
		body.fill(0x61);
		return [header(name, prefix, size), body];
	});
	const tar = new Uint8Array((blocks.length + 2) * BLOCK);
	let offset = 0;
	for (const block of blocks) {
		tar.set(block, offset);
		offset += block.length;
	}

	return gzipSync(tar);
}

/**
 * Read an entry's mode field and check its header checksum.
 *
 * @param gzipped - The `.tgz` contents.
 * @param index - The entry's position in the tarball.
 * @returns The octal mode, or `"bad checksum"`.
 */
export function entryMode(gzipped: Uint8Array, index: number): string {
	const tar = gunzipSync(gzipped);
	let offset = 0;
	for (let entry = 0; entry < index; entry += 1) {
		const size = Number.parseInt(text(tar.subarray(offset + 124, offset + 136)), 8);
		offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
	}

	const block = new Uint8Array(tar.subarray(offset, offset + BLOCK));
	const stored = Number.parseInt(text(block.subarray(148, 154)), 8);
	block.fill(0x20, 148, 156);
	const sum = block.reduce((total, byte) => total + byte, 0);
	return sum === stored ? text(block.subarray(100, 107)) : "bad checksum";
}

function header(name: string, prefix: string, size: number): Uint8Array {
	const block = new Uint8Array(BLOCK);
	block.set(ENCODER.encode(name), 0);
	block.set(ENCODER.encode("0000644\0"), 100);
	block.set(ENCODER.encode(`${size.toString(8).padStart(11, "0")}\0`), 124);
	block.set(ENCODER.encode("ustar\u000000"), 257);
	block.set(ENCODER.encode(prefix), 345);
	block.fill(0x20, 148, 156);
	const sum = block.reduce((total, byte) => total + byte, 0);
	block.set(ENCODER.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
	return block;
}

function text(field: Uint8Array): string {
	return DECODER.decode(field);
}
