import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, onTestFinished } from "vitest";

import { createNodeSeams } from "../../src/seams/node-seams.ts";
import { waitUntilWatchingAsync } from "../helpers/real-file-watch.ts";
import { makeTemporaryDirectory } from "../helpers/temporary-directory.ts";

describe("real directory watch", () => {
	it("should observe real directory edits", async () => {
		expect.assertions(1);

		const directory = makeTemporaryDirectory();
		const { fileSystem } = createNodeSeams({
			input: new PassThrough(),
			nativeDirectory: undefined,
			noInstalledStudio: false,
			output: new PassThrough(),
			supervisorEntry: "/forge/supervisor.mjs",
		});
		const watcher = fileSystem.watch(directory);
		onTestFinished(() => {
			watcher.close();
		});
		await waitUntilWatchingAsync(watcher, directory);
		const filenames: Array<null | string> = [];
		watcher.on("change", (_event: string, filename: null | string) => {
			filenames.push(filename);
		});
		fileSystem.writeFileSync(path.join(directory, "note.txt"), "hello");

		await expect.poll(() => filenames).toContain("note.txt");
	});
});
