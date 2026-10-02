import path from "node:path";

export interface SpawnResult {
	readonly error?: Error | undefined;
	readonly status: null | number;
	readonly stdout?: string | undefined;
}

export type Spawn = (command: string, args: ReadonlyArray<string>) => SpawnResult;

/** What a Claude Code worktree hook prints and how it exits. */
export interface HookResult {
	readonly code: 0 | 1;
	readonly stderr: string;
	readonly stdout: string;
}

/** Access to the Claude Code config file that holds per-project trust. */
export interface ConfigFile {
	readonly path: string;
	/** Returns `undefined` when the file does not exist. */
	readonly read: (file: string) => string | undefined;
	/** Returns `undefined` when the path does not resolve. */
	readonly realpath: (file: string) => string | undefined;
	readonly write: (file: string, contents: string) => void;
}

export interface CreateDependencies {
	readonly platform: NodeJS.Platform;
	/** Runs in the project directory. */
	readonly spawn: Spawn;
	readonly stdin: string;
	readonly trust: (worktreePath: string) => void;
}

export interface RemoveDependencies {
	readonly platform: NodeJS.Platform;
	readonly spawn: Spawn;
	readonly stdin: string;
}

const REMOTE_PREFIX = "origin/";
const FALLBACK_BASE = `${REMOTE_PREFIX}main`;

/**
 * Picks the worktrunk executable. On Windows, `wt` can resolve to Windows
 * Terminal; `git-wt.exe` cannot.
 * @param platform - The Node platform.
 * @returns The executable to spawn.
 */
export function worktrunkBinary(platform: NodeJS.Platform): string {
	return platform === "win32" ? "git-wt.exe" : "wt";
}

/**
 * The project root for the hook. The desktop app can run the hook without
 * `CLAUDE_PROJECT_DIR`; its working directory is then the project root.
 * @param environment - Holds `CLAUDE_PROJECT_DIR`.
 * @param cwd - The hook's working directory.
 * @returns `CLAUDE_PROJECT_DIR`, or `cwd` when it is unset.
 */
export function resolveProjectDirectory(
	environment: Readonly<Record<string, string | undefined>>,
	cwd: string,
): string {
	const directory = environment["CLAUDE_PROJECT_DIR"];
	return directory === undefined || directory === "" ? cwd : directory;
}

/**
 * The Claude Code config file: `.claude.json` in `CLAUDE_CONFIG_DIR`, else in
 * the home directory.
 * @param environment - The hook's environment.
 * @param home - The home directory.
 * @returns The config file path.
 */
export function resolveClaudeConfigPath(
	environment: Readonly<Record<string, string | undefined>>,
	home: string,
): string {
	const directory = environment["CLAUDE_CONFIG_DIR"];
	return path.join(
		directory === undefined || directory === "" ? home : directory,
		".claude.json",
	);
}

/**
 * Marks a worktree as trusted in the Claude Code config, under its real path
 * and its literal path. The desktop app shows no diff for an untrusted path,
 * and it does not trust a worktree that a hook made.
 * @param worktreePath - The worktree path the hook prints.
 * @param config - The config file.
 */
export function trustWorktree(worktreePath: string, config: ConfigFile): void {
	const raw = config.read(config.path);
	const parsed: unknown = raw === undefined ? {} : JSON.parse(raw);
	if (!isRecord(parsed)) {
		throw new TypeError(`${config.path} is not a JSON object`);
	}

	const projects = isRecord(parsed["projects"]) ? parsed["projects"] : {};
	const keys = new Set([config.realpath(worktreePath) ?? worktreePath, worktreePath]);
	const untrusted = [...keys].filter((key) => {
		const entry = projects[key];
		return !isRecord(entry) || entry["hasTrustDialogAccepted"] !== true;
	});
	if (untrusted.length === 0) {
		return;
	}

	for (const key of untrusted) {
		const entry = projects[key];
		projects[key] = { ...(isRecord(entry) ? entry : {}), hasTrustDialogAccepted: true };
	}

	config.write(config.path, JSON.stringify({ ...parsed, projects }, undefined, 2));
}

/**
 * The `WorktreeCreate` hook: worktrunk makes the worktree from the fetched
 * remote default branch and runs the project's start hooks.
 * @param dependencies - The hook's input and effects.
 * @returns What to print and the exit code.
 */
export function runWorktreeCreate({
	platform,
	spawn,
	stdin,
	trust,
}: CreateDependencies): HookResult {
	const name = readField(stdin, "name");
	if (name === undefined) {
		return failure("worktree-create: missing `name` in stdin payload");
	}

	const base = resolveBase(spawn);
	// Best-effort: offline, the last-fetched ref still exists.
	spawn("git", ["fetch", "origin", base.slice(REMOTE_PREFIX.length), "--quiet"]);

	const binary = worktrunkBinary(platform);
	const result = spawn(binary, [
		"switch",
		"--create",
		name,
		"--base",
		base,
		"--no-cd",
		"--yes",
		"--format",
		"json",
	]);
	const spawnFailure = describeFailure(binary, `switch --create ${name}`, result);
	if (spawnFailure !== undefined) {
		return failure(`worktree-create: ${spawnFailure}`);
	}

	const worktreePath = findWorktreePath(result.stdout ?? "");
	if (worktreePath === undefined) {
		return failure(`worktree-create: ${binary} printed no worktree path`);
	}

	return { code: 0, stderr: tryTrust(trust, worktreePath), stdout: `${worktreePath}\n` };
}

/**
 * The `WorktreeRemove` hook: worktrunk removes the worktree, dirty or not.
 * @param dependencies - The hook's input and effects.
 * @returns What to print and the exit code.
 */
export function runWorktreeRemove({ platform, spawn, stdin }: RemoveDependencies): HookResult {
	const worktreePath = readField(stdin, "worktree_path");
	if (worktreePath === undefined) {
		return failure("worktree-remove: missing `worktree_path` in stdin payload");
	}

	const binary = worktrunkBinary(platform);
	const result = spawn(binary, ["remove", worktreePath, "--foreground", "--force", "--yes"]);
	const spawnFailure = describeFailure(binary, `remove ${worktreePath}`, result);
	return spawnFailure === undefined
		? { code: 0, stderr: "", stdout: "" }
		: failure(`worktree-remove: ${spawnFailure}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

function readField(raw: string, key: string): string | undefined {
	const parsed = parseJson(raw);
	const value = isRecord(parsed) ? parsed[key] : undefined;
	return typeof value === "string" && value !== "" ? value : undefined;
}

function failure(message: string): HookResult {
	return { code: 1, stderr: `${message}\n`, stdout: "" };
}

function resolveBase(spawn: Spawn): string {
	const ref = (spawn("git", ["rev-parse", "--abbrev-ref", "origin/HEAD"]).stdout ?? "").trim();
	return ref.startsWith(REMOTE_PREFIX) ? ref : FALLBACK_BASE;
}

function describeFailure(binary: string, action: string, result: SpawnResult): string | undefined {
	if (result.error !== undefined) {
		return `could not spawn ${binary} (${result.error.message}); is worktrunk installed?`;
	}

	return result.status === 0
		? undefined
		: `${binary} ${action} failed (exit ${String(result.status)})`;
}

/**
 * Start hooks print progress before the JSON result, so take the first line
 * that carries a path.
 * @param stdout - The output of `wt switch`.
 * @returns The worktree path, if any line has one.
 */
function findWorktreePath(stdout: string): string | undefined {
	return stdout
		.split("\n")
		.map((line) => readField(line, "path"))
		.find((value) => value !== undefined);
}

/**
 * A failed trust only costs the desktop diff view, never the worktree.
 * @param trust - Trusts the worktree.
 * @param worktreePath - The new worktree.
 * @returns A warning, or an empty string.
 */
function tryTrust(trust: (worktreePath: string) => void, worktreePath: string): string {
	try {
		trust(worktreePath);
		return "";
	} catch (err) {
		return `worktree-create: could not trust ${worktreePath}: ${String(err)}\n`;
	}
}
