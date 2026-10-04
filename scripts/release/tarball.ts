import { gunzipSync, gzipSync } from "node:zlib";

const BLOCK = 512;
const CHECKSUM_OFFSET = 148;
const CHECKSUM_LENGTH = 8;
const DECODER = new TextDecoder();
const ENCODER = new TextEncoder();

/**
 * Set the mode of one entry in a gzipped ustar tarball. A tarball packed on
 * Windows stores every file as 0644, and npm keeps the stored mode.
 * @param gzipped - The `.tgz` contents.
 * @param entry - The entry path, such as `package/forge-reaper`.
 * @param mode - The new permission bits.
 * @returns The new `.tgz` contents.
 */
export function setEntryMode(gzipped: Uint8Array, entry: string, mode: number): Uint8Array {
	const tar = new Uint8Array(gunzipSync(gzipped));
	for (let offset = 0; offset + BLOCK <= tar.length;) {
		const name = entryName(tar, offset);
		if (name === "") {
			break;
		}

		if (name === entry) {
			writeOctal(tar, offset + 100, 8, mode);
			writeChecksum(tar, offset);
			return gzipSync(tar);
		}

		const size = Number.parseInt(readText(tar, offset + 124, 12), 8);
		offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
	}

	throw new Error(`${entry} is not in the tarball`);
}

function readText(tar: Uint8Array, offset: number, length: number): string {
	const [text = ""] = DECODER.decode(tar.subarray(offset, offset + length)).split("\u0000", 1);
	return text.trim();
}

function entryName(tar: Uint8Array, offset: number): string {
	const name = readText(tar, offset, 100);
	const prefix = readText(tar, offset + 345, 155);
	return prefix === "" ? name : `${prefix}/${name}`;
}

function writeChecksum(tar: Uint8Array, offset: number): void {
	const header = tar.subarray(offset, offset + BLOCK);
	header.fill(0x20, CHECKSUM_OFFSET, CHECKSUM_OFFSET + CHECKSUM_LENGTH);
	const sum = header.reduce((total, byte) => total + byte, 0);
	header.set(ENCODER.encode(`${sum.toString(8).padStart(6, "0")}\u0000 `), CHECKSUM_OFFSET);
}

function writeOctal(tar: Uint8Array, offset: number, length: number, value: number): void {
	tar.set(ENCODER.encode(`${value.toString(8).padStart(length - 1, "0")}\u0000`), offset);
}
