import path from "node:path";
import { describe, expect, it } from "vitest";

import type { ConfigFile, Spawn, SpawnResult } from "./worktree.ts";
import {
	resolveClaudeConfigPath,
	resolveProjectDirectory,
	runWorktreeCreate,
	runWorktreeRemove,
	trustWorktree,
	worktrunkBinary,
} from "./worktree.ts";

const WORKTREE = "/repos/forge.feature";
const CREATE_STDIN = '{"name":"feature"}';
const REMOVE_STDIN = `{"worktree_path":"${WORKTREE}"}`;

interface FakeSpawnOptions {
	originHead?: SpawnResult;
	worktrunk?: SpawnResult;
}

function fakeSpawn({
	originHead = { status: 0, stdout: "origin/main\n" },
	worktrunk = { status: 0, stdout: `${JSON.stringify({ path: WORKTREE })}\n` },
}: FakeSpawnOptions = {}) {
	const calls: Array<ReadonlyArray<string>> = [];
	function spawn(command: string, args: ReadonlyArray<string>): SpawnResult {
		calls.push([command, ...args]);
		if (command !== "git") {
			return worktrunk;
		}

		return args[0] === "rev-parse" ? originHead : { status: 0 };
	}

	return { calls, spawn };
}

function create(spawn: Spawn, trust: (worktreePath: string) => void = () => {}) {
	return runWorktreeCreate({ platform: "linux", spawn, stdin: CREATE_STDIN, trust });
}

function memoryConfig(contents?: string, realpath?: string) {
	const configPath = "/home/.claude.json";
	const files = new Map(contents === undefined ? [] : [[configPath, contents]]);
	const writes: Array<string> = [];
	const config: ConfigFile = {
		path: configPath,
		read: (file) => files.get(file),
		realpath: () => realpath,
		write: (file, written) => {
			writes.push(written);
			files.set(file, written);
		},
	};

	return { config, read: (): unknown => JSON.parse(files.get(configPath) ?? "null"), writes };
}

describe(worktrunkBinary, () => {
	it("should use git-wt.exe on Windows, where wt can be Windows Terminal", () => {
		expect.assertions(1);

		expect(worktrunkBinary("win32")).toBe("git-wt.exe");
	});

	it("should use wt elsewhere", () => {
		expect.assertions(1);

		expect(worktrunkBinary("darwin")).toBe("wt");
	});
});

describe(resolveProjectDirectory, () => {
	it("should take CLAUDE_PROJECT_DIR when it is set", () => {
		expect.assertions(1);

		expect(resolveProjectDirectory({ CLAUDE_PROJECT_DIR: "/project" }, "/cwd")).toBe(
			"/project",
		);
	});

	it("should fall back to the working directory when it is empty or unset", () => {
		expect.assertions(2);

		expect(resolveProjectDirectory({ CLAUDE_PROJECT_DIR: "" }, "/cwd")).toBe("/cwd");
		expect(resolveProjectDirectory({}, "/cwd")).toBe("/cwd");
	});
});

describe(resolveClaudeConfigPath, () => {
	it("should put the config in CLAUDE_CONFIG_DIR when it is set", () => {
		expect.assertions(1);

		expect(resolveClaudeConfigPath({ CLAUDE_CONFIG_DIR: "/config" }, "/home")).toBe(
			path.join("/config", ".claude.json"),
		);
	});

	it("should put the config in the home directory when it is empty or unset", () => {
		expect.assertions(2);

		expect(resolveClaudeConfigPath({ CLAUDE_CONFIG_DIR: "" }, "/home")).toBe(
			path.join("/home", ".claude.json"),
		);
		expect(resolveClaudeConfigPath({}, "/home")).toBe(path.join("/home", ".claude.json"));
	});
});

describe(trustWorktree, () => {
	it("should create the config when it does not exist", () => {
		expect.assertions(1);

		const { config, read } = memoryConfig();
		trustWorktree(WORKTREE, config);

		expect(read()).toStrictEqual({
			projects: { [WORKTREE]: { hasTrustDialogAccepted: true } },
		});
	});

	it("should trust the real path and the literal path, and keep other fields", () => {
		expect.assertions(1);

		const { config, read } = memoryConfig(
			JSON.stringify({
				projects: { "/other": {}, [WORKTREE]: { allowedTools: ["Read"] } },
				theme: "dark",
			}),
			"D:/repos/forge.feature",
		);
		trustWorktree(WORKTREE, config);

		expect(read()).toStrictEqual({
			projects: {
				"/other": {},
				"D:/repos/forge.feature": { hasTrustDialogAccepted: true },
				[WORKTREE]: { allowedTools: ["Read"], hasTrustDialogAccepted: true },
			},
			theme: "dark",
		});
	});

	it("should replace a projects value that is not an object", () => {
		expect.assertions(1);

		const { config, read } = memoryConfig(JSON.stringify({ projects: [] }));
		trustWorktree(WORKTREE, config);

		expect(read()).toStrictEqual({
			projects: { [WORKTREE]: { hasTrustDialogAccepted: true } },
		});
	});

	it("should not write when the worktree is already trusted", () => {
		expect.assertions(1);

		const contents = JSON.stringify({
			projects: { [WORKTREE]: { hasTrustDialogAccepted: true } },
		});
		const { config, writes } = memoryConfig(contents);
		trustWorktree(WORKTREE, config);

		expect(writes).toBeEmpty();
	});

	it("should throw when the config is not a JSON object", () => {
		expect.assertions(1);

		const { config } = memoryConfig("[]");

		expect(() => {
			trustWorktree(WORKTREE, config);
		}).toThrow("/home/.claude.json is not a JSON object");
	});
});

describe(runWorktreeCreate, () => {
	it("should print the worktree path from worktrunk's JSON result", () => {
		expect.assertions(1);

		const { spawn } = fakeSpawn({
			worktrunk: {
				status: 0,
				stdout: `running pre-start\n{}\n${JSON.stringify({ path: WORKTREE })}\n`,
			},
		});

		expect(create(spawn)).toStrictEqual({ code: 0, stderr: "", stdout: `${WORKTREE}\n` });
	});

	it("should branch from the fetched remote default branch", () => {
		expect.assertions(1);

		const { calls, spawn } = fakeSpawn({ originHead: { status: 0, stdout: "origin/trunk\n" } });
		create(spawn);

		expect(calls).toStrictEqual([
			["git", "rev-parse", "--abbrev-ref", "origin/HEAD"],
			["git", "fetch", "origin", "trunk", "--quiet"],
			[
				"wt",
				"switch",
				"--create",
				"feature",
				"--base",
				"origin/trunk",
				"--no-cd",
				"--yes",
				"--format",
				"json",
			],
		]);
	});

	it("should fall back to origin/main when origin/HEAD is not set", () => {
		expect.assertions(1);

		const { calls, spawn } = fakeSpawn({ originHead: { status: 128 } });
		create(spawn);

		expect(calls[1]).toStrictEqual(["git", "fetch", "origin", "main", "--quiet"]);
	});

	it("should trust the new worktree", () => {
		expect.assertions(1);

		const trusted: Array<string> = [];
		create(fakeSpawn().spawn, (worktreePath) => {
			trusted.push(worktreePath);
		});

		expect(trusted).toStrictEqual([WORKTREE]);
	});

	it("should still succeed when trust fails", () => {
		expect.assertions(1);

		const result = create(fakeSpawn().spawn, () => {
			throw new Error("locked");
		});

		expect(result).toStrictEqual({
			code: 0,
			stderr: `worktree-create: could not trust ${WORKTREE}: Error: locked\n`,
			stdout: `${WORKTREE}\n`,
		});
	});

	it.for([
		{ stdin: "{", what: "not JSON" },
		{ stdin: "{}", what: "no name" },
		{ stdin: '{"name":""}', what: "an empty name" },
		{ stdin: '{"name":1}', what: "a name that is not a string" },
	])("should fail when stdin has $what", ({ stdin }) => {
		expect.assertions(1);

		const result = runWorktreeCreate({
			platform: "linux",
			spawn: fakeSpawn().spawn,
			stdin,
			trust: () => {},
		});

		expect(result).toStrictEqual({
			code: 1,
			stderr: "worktree-create: missing `name` in stdin payload\n",
			stdout: "",
		});
	});

	it("should fail when worktrunk does not spawn", () => {
		expect.assertions(1);

		const { spawn } = fakeSpawn({ worktrunk: { error: new Error("ENOENT"), status: null } });

		expect(create(spawn).stderr).toBe(
			"worktree-create: could not spawn wt (ENOENT); is worktrunk installed?\n",
		);
	});

	it("should fail when worktrunk exits non-zero", () => {
		expect.assertions(1);

		const { spawn } = fakeSpawn({ worktrunk: { status: 2 } });

		expect(create(spawn)).toStrictEqual({
			code: 1,
			stderr: "worktree-create: wt switch --create feature failed (exit 2)\n",
			stdout: "",
		});
	});

	it("should fail when worktrunk prints no path", () => {
		expect.assertions(1);

		const { spawn } = fakeSpawn({ worktrunk: { status: 0 } });

		expect(create(spawn).stderr).toBe("worktree-create: wt printed no worktree path\n");
	});
});

describe(runWorktreeRemove, () => {
	it("should remove the worktree with worktrunk, dirty or not", () => {
		expect.assertions(2);

		const { calls, spawn } = fakeSpawn();
		const result = runWorktreeRemove({ platform: "win32", spawn, stdin: REMOVE_STDIN });

		expect(result).toStrictEqual({ code: 0, stderr: "", stdout: "" });
		expect(calls).toStrictEqual([
			["git-wt.exe", "remove", WORKTREE, "--foreground", "--force", "--yes"],
		]);
	});

	it("should fail when stdin has no worktree path", () => {
		expect.assertions(1);

		const result = runWorktreeRemove({
			platform: "linux",
			spawn: fakeSpawn().spawn,
			stdin: "{}",
		});

		expect(result.stderr).toBe("worktree-remove: missing `worktree_path` in stdin payload\n");
	});

	it("should fail when worktrunk fails", () => {
		expect.assertions(1);

		const { spawn } = fakeSpawn({ worktrunk: { status: 1 } });
		const result = runWorktreeRemove({ platform: "linux", spawn, stdin: REMOVE_STDIN });

		expect(result).toStrictEqual({
			code: 1,
			stderr: `worktree-remove: wt remove ${WORKTREE} failed (exit 1)\n`,
			stdout: "",
		});
	});
});
