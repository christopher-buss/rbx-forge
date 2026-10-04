import path from "node:path";

export interface ReadResult {
	readonly status: null | number;
	readonly stdout: string;
}

/** Process effects. `run` inherits stdio; `read` captures stdout. */
export interface Processes {
	readonly read: (command: string, args: ReadonlyArray<string>) => ReadResult;
	readonly run: (
		command: string,
		args: ReadonlyArray<string>,
		environment?: Readonly<Record<string, string>>,
	) => null | number;
}

/** File effects. Directories are made and removed recursively. */
export interface ReleaseFiles {
	readonly chmod: (file: string, mode: number) => void;
	readonly copy: (from: string, to: string) => void;
	readonly exists: (file: string) => boolean;
	readonly mkdir: (directory: string) => void;
	readonly read: (file: string) => string;
	readonly remove: (directory: string) => void;
	readonly write: (file: string, contents: string) => void;
}

export interface NativeTarget {
	readonly cpu: string;
	readonly libc?: "glibc" | "musl";
	readonly os: string;
	/** The Rust triple, as in `package.json#napi.targets`. */
	readonly rust: string;
	/** The napi platform name: `@rbx-forge/native-<target>`. */
	readonly target: string;
}

export interface CheckDependencies extends Processes {
	readonly log: (message: string) => void;
	readonly platform: NodeJS.Platform;
}

export interface BootstrapOptions {
	/** Holds one `native-<rust triple>` directory per target. */
	readonly artifacts: string;
	/** The repository root. */
	readonly root: string;
	/** Emptied, then given one platform package per target. */
	readonly staging: string;
	readonly version: string;
}

export interface PublishOptions extends BootstrapOptions {
	readonly tag: "latest" | "next";
}

export interface PublishDependencies extends Processes {
	readonly files: ReleaseFiles;
	readonly log: (message: string) => void;
}

interface Manifest extends Record<string, unknown> {
	readonly version: string;
}

export const NATIVE_TARGETS: ReadonlyArray<NativeTarget> = [
	{ cpu: "x64", os: "win32", rust: "x86_64-pc-windows-msvc", target: "win32-x64-msvc" },
	{ cpu: "arm64", os: "win32", rust: "aarch64-pc-windows-msvc", target: "win32-arm64-msvc" },
	{ cpu: "x64", os: "darwin", rust: "x86_64-apple-darwin", target: "darwin-x64" },
	{ cpu: "arm64", os: "darwin", rust: "aarch64-apple-darwin", target: "darwin-arm64" },
	{
		cpu: "x64",
		libc: "glibc",
		os: "linux",
		rust: "x86_64-unknown-linux-gnu",
		target: "linux-x64-gnu",
	},
	{
		cpu: "arm64",
		libc: "glibc",
		os: "linux",
		rust: "aarch64-unknown-linux-gnu",
		target: "linux-arm64-gnu",
	},
	{
		cpu: "x64",
		libc: "musl",
		os: "linux",
		rust: "x86_64-unknown-linux-musl",
		target: "linux-x64-musl",
	},
	{
		cpu: "arm64",
		libc: "musl",
		os: "linux",
		rust: "aarch64-unknown-linux-musl",
		target: "linux-arm64-musl",
	},
];

const NATIVE_PREFIX = "@rbx-forge/native-";

/** Every test project but `other-user`, which needs a second local user. */
const GATE_STEPS: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
	["pnpm", ["build:all"]],
	["cargo", ["test", "--manifest-path", "reaper/Cargo.toml"]],
	["pnpm", ["typecheck"]],
	["pnpm", ["lint"]],
	["pnpm", ["knip"]],
	["pnpm", ["test:unit"]],
	["pnpm", ["test:integration"]],
	["pnpm", ["test:e2e"]],
];

/**
 * The local release gate (bumpp's `preversion`): build and every test project
 * that can run here, real Studio included on Windows.
 * @param dependencies - Platform, processes, and log.
 * @returns The exit code.
 */
export function runReleaseCheck({ log, platform, read, run }: CheckDependencies): 0 | 1 {
	if (platform !== "win32" && platform !== "darwin") {
		log(`release-check: release from Windows or macOS, not ${platform}`);
		return 1;
	}

	const problem = findHeadProblem({ read, run });
	if (problem !== undefined) {
		log(`release-check: ${problem}`);
		return 1;
	}

	// The real-Studio specs run only on Windows; CI never runs them.
	const environment = platform === "win32" ? { RBX_FORGE_TEST_REAL_STUDIO: "1" } : undefined;
	if (environment === undefined) {
		log("release-check: real-Studio specs are Windows only; they skip on macOS");
	}

	for (const [command, args] of GATE_STEPS) {
		log(`release-check: ${command} ${args.join(" ")}`);
		if (run(command, args, environment) !== 0) {
			log(`release-check: ${command} ${args.join(" ")} failed`);
			return 1;
		}
	}

	return 0;
}

/**
 * The manifest of one platform package: the addon plus `forge-reaper`.
 * @param root - The root `package.json`.
 * @param target - The native target.
 * @param version - The release version.
 * @returns The platform package's `package.json`.
 */
export function platformManifest(
	root: Readonly<Record<string, unknown>>,
	target: NativeTarget,
	version: string,
): Record<string, unknown> {
	const addon = `forge-native.${target.target}.node`;
	return {
		name: `${NATIVE_PREFIX}${target.target}`,
		author: root["author"],
		bugs: root["bugs"],
		cpu: [target.cpu],
		description: `The ${target.rust} native build of rbx-forge`,
		engines: root["engines"],
		files: [addon, reaperName(target)],
		homepage: root["homepage"],
		license: root["license"],
		version,
		...(target.libc === undefined ? {} : { libc: [target.libc] }),
		main: addon,
		os: [target.os],
		repository: root["repository"],
	};
}

/**
 * The version a tag push releases: the root `package.json` version, which the
 * tag must name. A prerelease goes out only through {@link bootstrapRelease}.
 * @param manifest - The root `package.json` text.
 * @param reference - The pushed tag (`GITHUB_REF_NAME`).
 * @returns The stable version to publish.
 */
export function releaseVersion(manifest: string, reference: string | undefined): string {
	const { version } = readManifest(manifest);
	if (reference !== `v${version}`) {
		throw new Error(
			`tag ${reference ?? "(none)"} does not name package.json version ${version}`,
		);
	}

	if (version.includes("-")) {
		throw new Error(`a tag releases a stable version only, not ${version}`);
	}

	return version;
}

/**
 * Publish the platform packages, then the root package with them as optional
 * dependencies. A package already on npm at this version is skipped, so a
 * failed run can run again. The root `package.json` is restored after.
 * @param dependencies - Files, processes, and log.
 * @param options - Paths, version, and dist-tag.
 */
export function publishRelease(dependencies: PublishDependencies, options: PublishOptions): void {
	const { files } = dependencies;
	const manifestPath = path.join(options.root, "package.json");
	const original = files.read(manifestPath);
	const root = readManifest(original);

	for (const directory of stageNativePackages(files, root, options)) {
		publishOnce(dependencies, options, directory.name, directory.path);
	}

	const optionalDependencies = Object.fromEntries(
		NATIVE_TARGETS.map((target) => [`${NATIVE_PREFIX}${target.target}`, options.version]),
	);
	const published = { ...root, optionalDependencies, version: options.version };
	files.write(manifestPath, `${JSON.stringify(published, undefined, "\t")}\n`);
	try {
		publishOnce(dependencies, options, String(root["name"]), options.root);
	} finally {
		files.write(manifestPath, original);
	}
}

/**
 * The one-time first publish from this computer, before npm trusted
 * publishing is set up: a prerelease on `next`, from the native artifacts of
 * the successful CI run for HEAD.
 * @param dependencies - Files, processes, and log.
 * @param options - Paths and the prerelease version.
 */
export function bootstrapRelease(
	dependencies: PublishDependencies,
	options: BootstrapOptions,
): void {
	const { read, run } = dependencies;
	if (!options.version.includes("-")) {
		throw new Error(`bootstrap publishes a prerelease only, not ${options.version}`);
	}

	if (readText(read, "git", ["status", "--porcelain"]) !== "") {
		throw new Error("the working tree has changes");
	}

	const id = findCiRun(read, readText(read, "git", ["rev-parse", "HEAD"]));
	dependencies.files.remove(options.artifacts);
	runOrThrow(run, "gh", [
		"run",
		"download",
		String(id),
		"--pattern",
		"native-*",
		"--dir",
		options.artifacts,
	]);
	runOrThrow(run, "pnpm", ["build"]);
	publishRelease(dependencies, { ...options, tag: "next" });
}

function readText(read: Processes["read"], command: string, args: ReadonlyArray<string>): string {
	const result = read(command, args);
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} exited with ${String(result.status)}`);
	}

	return result.stdout.trim();
}

function runOrThrow(run: Processes["run"], command: string, args: ReadonlyArray<string>): void {
	const status = run(command, args);
	if (status !== 0) {
		throw new Error(`${command} ${args.join(" ")} exited with ${String(status)}`);
	}
}

function findHeadProblem({ read, run }: Processes): string | undefined {
	const branch = readText(read, "git", ["branch", "--show-current"]);
	if (branch !== "main") {
		return `release from main, not ${branch === "" ? "a detached HEAD" : branch}`;
	}

	if (readText(read, "git", ["status", "--porcelain"]) !== "") {
		return "the working tree has changes";
	}

	runOrThrow(run, "git", ["fetch", "origin", "main", "--quiet"]);
	const head = readText(read, "git", ["rev-parse", "HEAD"]);
	const remote = readText(read, "git", ["rev-parse", "origin/main"]);
	return head === remote ? undefined : "HEAD is not origin/main; pull or push first";
}

function reaperName(target: NativeTarget): string {
	return target.os === "win32" ? "forge-reaper.exe" : "forge-reaper";
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

function readManifest(text: string): Manifest {
	const manifest = parseJson(text);
	if (!isRecord(manifest) || typeof manifest["version"] !== "string") {
		throw new TypeError("package.json has no version");
	}

	return { ...manifest, version: manifest["version"] };
}

function publishOnce(
	{ log, read, run }: PublishDependencies,
	{ tag, version }: PublishOptions,
	name: string,
	directory: string,
): void {
	const published = read("npm", ["view", `${name}@${version}`, "version"]);
	if (published.status === 0 && published.stdout.trim() === version) {
		log(`release: ${name}@${version} is on npm; skipped`);
		return;
	}

	runOrThrow(run, "pnpm", [
		"publish",
		directory,
		"--access",
		"public",
		"--no-git-checks",
		"--tag",
		tag,
	]);
}

function stagePackage(
	files: ReleaseFiles,
	root: Manifest,
	{ root: rootDirectory, staging, version }: PublishOptions,
	{ addon, reaper, target }: { addon: string; reaper: string; target: NativeTarget },
): { name: string; path: string } {
	const directory = path.join(staging, target.target);
	const manifest = platformManifest(root, target, version);
	files.mkdir(directory);
	files.copy(addon, path.join(directory, path.basename(addon)));
	// Artifact downloads drop the exec bit; the reaper locator never sets it.
	files.copy(reaper, path.join(directory, reaperName(target)));
	files.chmod(path.join(directory, reaperName(target)), 0o755);
	files.copy(path.join(rootDirectory, "LICENSE"), path.join(directory, "LICENSE"));
	files.write(
		path.join(directory, "package.json"),
		`${JSON.stringify(manifest, undefined, "\t")}\n`,
	);
	return { name: String(manifest["name"]), path: directory };
}

function stageNativePackages(
	files: ReleaseFiles,
	root: Manifest,
	options: PublishOptions,
): Array<{ name: string; path: string }> {
	const sources = NATIVE_TARGETS.map((target) => {
		const artifact = path.join(options.artifacts, `native-${target.rust}`);
		return {
			addon: path.join(artifact, "napi", `forge-native.${target.target}.node`),
			reaper: path.join(artifact, target.rust, "release", reaperName(target)),
			target,
		};
	});
	const missing = sources
		.flatMap(({ addon, reaper }) => [addon, reaper])
		.filter((file) => !files.exists(file));
	if (missing.length > 0) {
		throw new Error(`missing native artifacts:\n${missing.join("\n")}`);
	}

	files.remove(options.staging);
	return sources.map((source) => stagePackage(files, root, options, source));
}

function findCiRun(read: Processes["read"], head: string): number {
	const runs = parseJson(
		readText(read, "gh", [
			"run",
			"list",
			"--workflow",
			"ci.yaml",
			"--commit",
			head,
			"--status",
			"success",
			"--limit",
			"1",
			"--json",
			"databaseId",
		]),
	);
	const [first] = Array.isArray(runs) ? runs : [];
	const id = isRecord(first) ? first["databaseId"] : undefined;
	if (typeof id !== "number") {
		throw new TypeError(`no successful CI run for ${head}; push it and wait for CI`);
	}

	return id;
}
