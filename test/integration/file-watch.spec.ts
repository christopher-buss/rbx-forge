import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, onTestFinished } from "vitest";

import { createNodeSeams } from "../../src/seams/node-seams.ts";
import { makeTemporaryDirectory } from "../helpers/temporary-directory.ts";

describe("real directory watch", () => {
	it("should observe real directory edits", async () => {
		expect.assertions(1);

		const directory = makeTemporaryDirectory();
		const { fileSystem } = createNodeSeams({
			input: new PassThrough(),
			nativeDirectory: undefined,
			output: new PassThrough(),
			supervisorEntry: "/forge/supervisor.mjs",
		});
		const watcher = fileSystem.watch(directory);
		onTestFinished(() => {
			watcher.close();
		});
		const changed = new Promise<string>((resolve) => {
			watcher.once("change", (_event: string, filename: string) => {
				resolve(filename);
			});
		});
		fileSystem.writeFileSync(path.join(directory, "note.txt"), "hello");

		await expect(changed).resolves.toBe("note.txt");
	});
});
