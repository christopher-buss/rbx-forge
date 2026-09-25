import path from "node:path";
import { describe, expect, it } from "vitest";

import { createMemoryFileSystem, PROJECT } from "../../test/helpers/seams.ts";
import { logFilePath, openLogFile } from "./log-file.ts";

const FILE = path.join(PROJECT, ".forge", "logs", "compile.log");

describe(logFilePath, () => {
	it("should put a service's log in the project's log folder", () => {
		expect.assertions(1);

		expect(logFilePath(PROJECT, "compile")).toBe(FILE);
	});
});

describe(openLogFile, () => {
	it("should create the log folder and append each line", () => {
		expect.assertions(1);

		const memory = createMemoryFileSystem();
		const log = openLogFile(memory.fileSystem, FILE);
		log.write("one");
		log.write("two");

		expect(memory.files()).toMatchObject({ ".forge/logs/compile.log": "one\ntwo\n" });
	});

	it("should append to a log from an earlier run", () => {
		expect.assertions(1);

		const memory = createMemoryFileSystem({ ".forge/logs/compile.log": "old\n" });
		openLogFile(memory.fileSystem, FILE).write("new");

		expect(memory.files()).toMatchObject({ ".forge/logs/compile.log": "old\nnew\n" });
	});

	it("should rotate the log when a line would take it past the size limit", () => {
		expect.assertions(1);

		const memory = createMemoryFileSystem();
		const log = openLogFile(memory.fileSystem, FILE, { keep: 2, maxBytes: 8 });
		for (const line of ["aaa", "bbb", "ccc", "ddd", "eee", "fff", "ggg"]) {
			log.write(line);
		}

		expect(memory.files()).toStrictEqual({
			".forge/logs/compile.log": "ggg\n",
			".forge/logs/compile.log.1": "eee\nfff\n",
			".forge/logs/compile.log.2": "ccc\nddd\n",
		});
	});

	it("should count the size of a log from an earlier run", () => {
		expect.assertions(1);

		const memory = createMemoryFileSystem({ ".forge/logs/compile.log": "old\nold\n" });
		openLogFile(memory.fileSystem, FILE, { keep: 1, maxBytes: 8 }).write("new");

		expect(memory.files()).toMatchObject({
			".forge/logs/compile.log": "new\n",
			".forge/logs/compile.log.1": "old\nold\n",
		});
	});

	it("should count bytes, not characters", () => {
		expect.assertions(1);

		const memory = createMemoryFileSystem();
		const log = openLogFile(memory.fileSystem, FILE, { keep: 1, maxBytes: 8 });
		log.write("✔✔");
		log.write("a");

		expect(memory.files()).toMatchObject({
			".forge/logs/compile.log": "a\n",
			".forge/logs/compile.log.1": "✔✔\n",
		});
	});

	it("should keep a line longer than the limit whole, in a file of its own", () => {
		expect.assertions(1);

		const memory = createMemoryFileSystem();
		const log = openLogFile(memory.fileSystem, FILE, { keep: 1, maxBytes: 4 });
		log.write("a long line");

		expect(memory.files()).toStrictEqual({
			".forge/logs/compile.log": "a long line\n",
		});
	});
});
