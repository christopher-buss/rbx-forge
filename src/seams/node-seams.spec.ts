import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { makeTemporaryDirectory } from "../../test/helpers/temporary-directory.ts";
import { createNodeSeams } from "./node-seams.ts";

function makeSeams(): ReturnType<typeof createNodeSeams> {
	return createNodeSeams({ input: new PassThrough(), output: new PassThrough() });
}

describe(createNodeSeams, () => {
	it("should read and write the real disk", () => {
		expect.assertions(1);

		const directory = makeTemporaryDirectory();
		const { fileSystem } = makeSeams();
		const file = path.join(directory, "note.txt");
		fileSystem.writeFileSync(file, "hello");

		expect(fileSystem.readFileSync(file, "utf8")).toBe("hello");
	});

	it("should load config files with the c12 loader", async () => {
		expect.assertions(1);

		const directory = makeTemporaryDirectory({
			"rbx-forge.config.json": '{ "projectType": "luau" }',
		});

		await expect(makeSeams().configLoader(directory)).resolves.toMatchObject({
			value: { projectType: "luau" },
		});
	});

	it("should spawn through node:child_process", () => {
		expect.assertions(1);

		// Only the function identity: unit tests never start a process.
		expect(makeSeams().childProcess.spawn.name).toBe("spawn");
	});

	it("should tell the time", () => {
		expect.assertions(1);

		expect(makeSeams().clock.now()).toBeGreaterThan(0);
	});

	it("should prompt on the given streams", async () => {
		expect.assertions(1);

		const input = new PassThrough();
		const { prompter } = createNodeSeams({ input, output: new PassThrough() });
		const answer = prompter.confirm("Go?", false);
		setImmediate(() => {
			input.write("y\n");
		});

		await expect(answer).resolves.toBeTrue();
	});
});
