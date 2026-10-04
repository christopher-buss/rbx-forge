import { parseTriple } from "@napi-rs/cli";

import path from "node:path";

import packageJson from "../../package.json" with { type: "json" };
import { setEntryMode } from "./tarball.ts";

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
	readonly copy: (from: string, to: string) => void;
	readonly exists: (file: string) => boolean;
	readonly mkdir: (directory: string) => void;
	readonly read: (file: string) => string;
	readonly readBytes: (file: string) => Uint8Array;
	readonly remove: (directory: string) => void;
	readonly write: (file: string, contents: string) => void;
	readonly writeBytes: (file: string, contents: Uint8Array) => void;
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

interface StagedPackage {
	readonly name: string;
	readonly directory: string;
	readonly target: NativeTarget;
}

interface Manifest extends Record<string, unknown> {
	readonly version: string;
}

/** Napi ABI to `package.json#libc`. */
const LIBC: Readonly<Record<string, "glibc" | "musl">> = { gnu: "glibc", musl: "musl" };

/** One per `package.json#napi.targets`, named as napi names them. */
export const NATIVE_TARGETS: ReadonlyArray<NativeTarget> = packageJson.napi.targets.map(
	(triple) => {
		const { abi, arch, platform, platformArchABI } = parseTriple(triple);
		const target: { -readonly [K in keyof NativeTarget]: NativeTarget[K] } = {
			cpu: arch,
			os: platform,
			rust: triple,
			target: platformArchABI,
		};
		const libc = abi === null ? undefined : LIBC[abi];
		if (libc !== undefined) {
			target.libc = libc;
		}

		return target;
	},
);

const MANIFEST = "package.json";
const NATIVE_PREFIX = "@rbx-forge/native-";
/** `owner/name` in a `github:` shorthand or a github.com URL. */
const GITHUB_REPOSITORY = /^(?:github:|.*github\.com[/:])([^/]+\/[^/]+?)(?:\.git)?$/;

/** Every test project but `other-user`, which needs a second local user. */
const GATE_STEPS: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
	["pnpm", ["typecheck"]],
	["pnpm", ["lint"]],
	["pnpm", ["knip"]],
	["pnpm", ["build:all"]],
	["cargo", ["test", "--manifest-path", "reaper/Cargo.toml"]],
	["pnpm", ["test:unit"]],
	["pnpm", ["test:integration"]],
	["pnpm", ["test:e2e"]],
];

/**
 * The local release gate (bumpp's `preversion`): build and every test project
 * that can run here, real Studio included on Windows.
 * @param dependencies - Platform, processes, and log.
 */
export function runReleaseCheck({ log, platform, read, run }: CheckDependencies): void {
	if (platform !== "win32" && platform !== "darwin") {
		throw new Error(`release from Windows or macOS, not ${platform}`);
	}

	assertCleanOriginMain({ read, run });

	// The real-Studio specs run only on Windows; CI never runs them.
	const environment = platform === "win32" ? { RBX_FORGE_TEST_REAL_STUDIO: "1" } : undefined;
	if (environment === undefined) {
		log("release-check: real-Studio specs are Windows only; they skip on macOS");
	}

	for (const [command, args] of GATE_STEPS) {
		log(`release-check: ${command} ${args.join(" ")}`);
		runOrThrow(run, command, args, environment);
	}
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
 * Refuse a prerelease: a tag releases a stable version only.
 * @param version - The version to release.
 */
export function assertStable(version: string): void {
	if (isPrerelease(version)) {
		throw new Error(`a tag releases a stable version only, not ${version}`);
	}
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

	assertStable(version);

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
	const manifestPath = path.join(options.root, MANIFEST);
	const original = files.read(manifestPath);
	const root = readManifest(original);

	for (const staged of stageNativePackages(files, root, options)) {
		publishOnce(dependencies, options, staged.name, () => {
			return packPlatform(dependencies, staged, options.version);
		});
	}

	const optionalDependencies = Object.fromEntries(
		NATIVE_TARGETS.map((target) => [`${NATIVE_PREFIX}${target.target}`, options.version]),
	);
	const published = { ...root, optionalDependencies, version: options.version };
	files.write(manifestPath, `${JSON.stringify(published, undefined, "\t")}\n`);
	try {
		publishOnce(dependencies, options, String(root["name"]), () => options.root);
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
	if (!isPrerelease(options.version)) {
		throw new Error(`bootstrap publishes a prerelease only, not ${options.version}`);
	}

	assertClean(read);
	// gh's own default repository is unset in a clone with several remotes.
	const repo = githubRepo(
		readManifest(dependencies.files.read(path.join(options.root, MANIFEST))),
	);
	const id = findCiRun(read, repo, readText(read, "git", ["rev-parse", "HEAD"]));
	dependencies.files.remove(options.artifacts);
	runOrThrow(run, "gh", [
		"run",
		"download",
		String(id),
		"--repo",
		repo,
		"--pattern",
		"native-*",
		"--dir",
		options.artifacts,
	]);
	runOrThrow(run, "pnpm", ["build"]);
	publishRelease(dependencies, { ...options, tag: "next" });
}

function runOrThrow(
	run: Processes["run"],
	command: string,
	args: ReadonlyArray<string>,
	environment?: Readonly<Record<string, string>>,
): void {
	const status = run(command, args, environment);
	if (status !== 0) {
		throw new Error(`${command} ${args.join(" ")} exited with ${String(status)}`);
	}
}

function readText(read: Processes["read"], command: string, args: ReadonlyArray<string>): string {
	const result = read(command, args);
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} exited with ${String(result.status)}`);
	}

	return result.stdout.trim();
}

function assertClean(read: Processes["read"]): void {
	if (readText(read, "git", ["status", "--porcelain"]) !== "") {
		throw new Error("the working tree has changes");
	}
}

function assertCleanOriginMain({ read, run }: Processes): void {
	const branch = readText(read, "git", ["branch", "--show-current"]);
	if (branch !== "main") {
		throw new Error(`release from main, not ${branch === "" ? "a detached HEAD" : branch}`);
	}

	assertClean(read);
	runOrThrow(run, "git", ["fetch", "origin", "main", "--quiet"]);
	if (
		readText(read, "git", ["rev-parse", "HEAD"]) !==
		readText(read, "git", ["rev-parse", "origin/main"])
	) {
		throw new Error("HEAD is not origin/main; pull or push first");
	}
}

function reaperName(target: NativeTarget): string {
	return target.os === "win32" ? "forge-reaper.exe" : "forge-reaper";
}

/**
 * Whether a semver version has a prerelease part (`2.0.0-rc.0`).
 * @param version - A semver version.
 * @returns `true` for a prerelease.
 */
function isPrerelease(version: string): boolean {
	return version.includes("-");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readManifest(text: string): Manifest {
	const manifest: unknown = JSON.parse(text);
	if (!isRecord(manifest) || typeof manifest["version"] !== "string") {
		throw new TypeError("package.json has no version");
	}

	return { ...manifest, version: manifest["version"] };
}

function publishOnce(
	{ log, read, run }: PublishDependencies,
	{ tag, version }: PublishOptions,
	name: string,
	prepare: () => string,
): void {
	const published = read("npm", ["view", `${name}@${version}`, "version", "--loglevel=silent"]);
	if (published.status === 0 && published.stdout.trim() === version) {
		log(`release: ${name}@${version} is on npm; skipped`);
		return;
	}

	runOrThrow(run, "pnpm", [
		"publish",
		prepare(),
		"--access",
		"public",
		"--no-git-checks",
		"--tag",
		tag,
	]);
}

/**
 * Pack a staged platform package and make its reaper executable in the
 * tarball: artifact downloads and a Windows pack both drop the exec bit, and
 * the reaper locator never sets it.
 * @param dependencies - Files and processes.
 * @param staged - The staged package.
 * @param version - The release version.
 * @returns The tarball to publish.
 */
function packPlatform(
	{ files, run }: PublishDependencies,
	{ name, directory, target }: StagedPackage,
	version: string,
): string {
	runOrThrow(run, "pnpm", ["--dir", directory, "pack", "--pack-destination", ".."]);
	const tarball = path.join(
		path.dirname(directory),
		`${name.slice(1).replace("/", "-")}-${version}.tgz`,
	);
	const entry = `package/${reaperName(target)}`;
	files.writeBytes(tarball, setEntryMode(files.readBytes(tarball), entry, 0o755));
	return tarball;
}

function stagePackage(
	files: ReleaseFiles,
	root: Manifest,
	{ root: rootDirectory, staging, version }: PublishOptions,
	{ addon, reaper, target }: { addon: string; reaper: string; target: NativeTarget },
): StagedPackage {
	const directory = path.join(staging, target.target);
	const manifest = platformManifest(root, target, version);
	files.mkdir(directory);
	files.copy(addon, path.join(directory, path.basename(addon)));
	files.copy(reaper, path.join(directory, reaperName(target)));
	files.copy(path.join(rootDirectory, "LICENSE"), path.join(directory, "LICENSE"));
	files.write(path.join(directory, MANIFEST), `${JSON.stringify(manifest, undefined, "\t")}\n`);
	return { name: String(manifest["name"]), directory, target };
}

function stageNativePackages(
	files: ReleaseFiles,
	root: Manifest,
	options: PublishOptions,
): Array<StagedPackage> {
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

/**
 * The GitHub `owner/name` that `package.json#repository` names.
 * @param manifest - The root `package.json`.
 * @returns The repository, for `gh --repo`.
 */
function githubRepo(manifest: Manifest): string {
	const field = manifest["repository"];
	const url = isRecord(field) ? field["url"] : field;
	const match = typeof url === "string" ? GITHUB_REPOSITORY.exec(url) : null;
	if (match?.[1] === undefined) {
		throw new Error("package.json#repository names no GitHub repository");
	}

	return match[1];
}

function findCiRun(read: Processes["read"], repo: string, head: string): number {
	const id = Number(
		readText(read, "gh", [
			"run",
			"list",
			"--repo",
			repo,
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
			"--jq",
			".[0].databaseId",
		]),
	);
	if (!Number.isSafeInteger(id) || id <= 0) {
		throw new Error(`no successful CI run for ${head}; push it and wait for CI`);
	}

	return id;
}
