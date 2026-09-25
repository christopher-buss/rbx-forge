import { Buffer } from "node:buffer";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createMemoryFileSystem, PROJECT } from "../../test/helpers/seams.ts";
import type { OutputFollower } from "./output-follower.ts";
import { followOutput } from "./output-follower.ts";

const FILE = path.join(PROJECT, "out.log");

interface Followed {
	append: (text: Buffer | string) => void;
	follower: OutputFollower;
	lines: Array<string>;
}

function follow(files: Record<string, string> = {}): Followed {
	const memory = createMemoryFileSystem(files);
	const lines: Array<string> = [];
	const follower = followOutput(memory.fileSystem, FILE, (line) => {
		lines.push(line);
	});
	return {
		append: (text) => {
			memory.fileSystem.writeFileSync(FILE, text, { flag: "a" });
		},
		follower,
		lines,
	};
}

describe(followOutput, () => {
	it("should read nothing while the file does not exist", () => {
		expect.assertions(1);

		const { follower, lines } = follow();
		follower.read();
		follower.finish();

		expect(lines).toStrictEqual([]);
	});

	it("should hand over each whole line once, and keep a partial line for later", () => {
		expect.assertions(2);

		const { append, follower, lines } = follow({ "out.log": "one\r\ntw" });
		follower.read();

		expect(lines).toStrictEqual(["one"]);

		append("o\nthree\n");
		follower.read();
		follower.read();

		expect(lines).toStrictEqual(["one", "two", "three"]);
	});

	it("should hand over a last line with no newline when it finishes", () => {
		expect.assertions(1);

		const { follower, lines } = follow({ "out.log": "one\nlast" });
		follower.finish();

		expect(lines).toStrictEqual(["one", "last"]);
	});

	it("should keep a character whose bytes arrive in two reads whole", () => {
		expect.assertions(1);

		const { append, follower, lines } = follow();
		const bytes = Buffer.from("é\n");
		append(bytes.subarray(0, 1));
		follower.read();
		append(bytes.subarray(1));
		follower.finish();

		expect(lines).toStrictEqual(["é"]);
	});

	it("should read output larger than one chunk", () => {
		expect.assertions(1);

		const long = "x".repeat(100_000);
		const { follower, lines } = follow({ "out.log": `${long}\nend\n` });
		follower.finish();

		expect(lines).toStrictEqual([long, "end"]);
	});
});
