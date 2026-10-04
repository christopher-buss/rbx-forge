import path from "node:path";
import { assert, describe, expect, it } from "vitest";

import packageJson from "../../package.json" with { type: "json" };
import { entryMode, gzippedTarball } from "../../test/helpers/tarball.ts";
import type { BootstrapOptions, PublishDependencies, ReadResult, ReleaseFiles } from "./release.ts";
import {
	bootstrapRelease,
	NATIVE_TARGETS,
	platformManifest,
	publishRelease,
	releaseVersion,
	runReleaseCheck,
} from "./release.ts";

const ROOT_MANIFEST = `${JSON.stringify({
	name: "rbx-forge",
	license: "MIT",
	repository: { type: "git", url: "git+https://github.com/owner/forge.git" },
	version: "1.0.0",
})}\n`;
const OPTIONS = { artifacts: "artifacts", root: "repo", staging: "staging" } satisfies Pick<
	BootstrapOptions,
	"artifacts" | "root" | "staging"
>;
/** What a pack writes: a reaper of each name, stored 0644. */
const PACKED = gzippedTarball([
	{ name: "package/forge-reaper", size: 1 },
	{ name: "package/forge-reaper.exe", size: 1 },
]);
const FLAGS = "--access public --no-git-checks";
const RUN_LIST =
	"gh run list --repo owner/forge --workflow ci.yaml --commit abc --status success --limit 1 --json databaseId --jq .[0].databaseId";
const BOOTSTRAP_READS = {
	"git rev-parse HEAD": "abc\n",
	"git status --porcelain": "",
	[RUN_LIST]: "42\n",
};

interface FakeOptions {
	/** Command lines that exit 1. */
	readonly failing?: ReadonlyArray<string>;
	/** The stdout of each command line; another line reads as exit 1. */
	readonly reads?: Record<string, string>;
}

function fakeProcesses({ failing = [], reads = {} }: FakeOptions = {}) {
	const runs: Array<string> = [];
	const environments: Array<Readonly<Record<string, string>> | undefined> = [];
	const logs: Array<string> = [];
	return {
		environments,
		log: (message: string) => {
			logs.push(message);
		},
		logs,
		read: (command: string, args: ReadonlyArray<string>): ReadResult => {
			const stdout = reads[[command, ...args].join(" ")];
			return stdout === undefined ? { status: 1, stdout: "" } : { status: 0, stdout };
		},
		run: (
			command: string,
			args: ReadonlyArray<string>,
			environment?: Readonly<Record<string, string>>,
		) => {
			const line = [command, ...args].join(" ");
			runs.push(line);
			environments.push(environment);
			return failing.includes(line) ? 1 : 0;
		},
		runs,
	};
}

const CLEAN_MAIN = {
	"git branch --show-current": "main\n",
	"git rev-parse HEAD": "abc\n",
	"git rev-parse origin/main": "abc\n",
	"git status --porcelain": "",
};

function fakeFiles(seed: Record<string, string> = {}) {
	const contents = new Map(Object.entries(seed));
	const bytes = new Map<string, Uint8Array>();
	const removed: Array<string> = [];
	const writes: Array<string> = [];
	const files: ReleaseFiles = {
		copy: (from, to) => {
			contents.set(to, contents.get(from) ?? "");
		},
		exists: (file) => contents.has(file),
		mkdir: () => {},
		read: (file) => contents.get(file) ?? "",
		readBytes: (file) => bytes.get(file) ?? PACKED,
		remove: (directory) => {
			removed.push(directory);
		},
		write: (file, text) => {
			writes.push(file);
			contents.set(file, text);
		},
		writeBytes: (file, written) => {
			bytes.set(file, written);
		},
	};
	return { bytes, contents, files, removed, writes };
}

function artifactFiles(): Record<string, string> {
	return Object.fromEntries(
		NATIVE_TARGETS.flatMap((target) => {
			const artifact = path.join("artifacts", `native-${target.rust}`);
			const reaper = target.os === "win32" ? "forge-reaper.exe" : "forge-reaper";
			return [
				[path.join(artifact, "napi", `forge-native.${target.target}.node`), "addon"],
				[path.join(artifact, target.rust, "release", reaper), "reaper"],
			];
		}),
	);
}

function publishSetup(reads: Record<string, string> = {}, failing: ReadonlyArray<string> = []) {
	const fakes = fakeFiles({
		...artifactFiles(),
		[path.join("repo", "LICENSE")]: "MIT",
		[path.join("repo", "package.json")]: ROOT_MANIFEST,
	});
	const processes = fakeProcesses({ failing, reads });
	const dependencies: PublishDependencies = { ...processes, files: fakes.files };
	return { ...fakes, dependencies, processes };
}

describe("native targets", () => {
	it("should name each napi target as napi does", () => {
		expect.assertions(2);

		expect(NATIVE_TARGETS.map((target) => target.rust)).toStrictEqual(packageJson.napi.targets);
		expect(NATIVE_TARGETS).toContainEqual({
			cpu: "arm64",
			libc: "glibc",
			os: "linux",
			rust: "aarch64-unknown-linux-gnu",
			target: "linux-arm64-gnu",
		});
	});
});

describe(platformManifest, () => {
	it("should ship the addon and the reaper for a musl target", () => {
		expect.assertions(1);

		const target = NATIVE_TARGETS.find(({ target: name }) => name === "linux-x64-musl");

		assert(target);

		expect(platformManifest({ license: "MIT" }, target, "2.0.0")).toMatchObject({
			name: "@rbx-forge/native-linux-x64-musl",
			cpu: ["x64"],
			files: ["forge-native.linux-x64-musl.node", "forge-reaper"],
			libc: ["musl"],
			license: "MIT",
			main: "forge-native.linux-x64-musl.node",
			os: ["linux"],
			version: "2.0.0",
		});
	});

	it("should name the Windows reaper with .exe and give no libc", () => {
		expect.assertions(2);

		const manifest = platformManifest({}, NATIVE_TARGETS[0]!, "2.0.0");

		expect(manifest["files"]).toStrictEqual([
			"forge-native.win32-x64-msvc.node",
			"forge-reaper.exe",
		]);
		expect(manifest).not.toHaveProperty("libc");
	});
});

describe(releaseVersion, () => {
	it("should return the version the tag names", () => {
		expect.assertions(1);

		expect(releaseVersion(ROOT_MANIFEST, "v1.0.0")).toBe("1.0.0");
	});

	it.for([
		{ reference: "v1.0.1", what: "another version" },
		{ reference: undefined, what: "no tag" },
	])("should throw for $what", ({ reference }) => {
		expect.assertions(1);

		expect(() => releaseVersion(ROOT_MANIFEST, reference)).toThrow(
			"does not name package.json version 1.0.0",
		);
	});

	it("should refuse a prerelease", () => {
		expect.assertions(1);

		const manifest = JSON.stringify({ version: "1.0.0-rc.0" });

		expect(() => releaseVersion(manifest, "v1.0.0-rc.0")).toThrow(
			"a tag releases a stable version only, not 1.0.0-rc.0",
		);
	});

	it("should throw when package.json has no version", () => {
		expect.assertions(1);

		expect(() => releaseVersion("{}", "v1.0.0")).toThrow("package.json has no version");
	});
});

describe(runReleaseCheck, () => {
	it("should run every gate step with real Studio on Windows", () => {
		expect.assertions(2);

		const processes = fakeProcesses({ reads: CLEAN_MAIN });

		runReleaseCheck({ ...processes, platform: "win32" });

		expect(processes.runs).toStrictEqual([
			"git fetch origin main --quiet",
			"pnpm typecheck",
			"pnpm lint",
			"pnpm knip",
			"pnpm build:all",
			"cargo test --manifest-path reaper/Cargo.toml",
			"pnpm test:unit",
			"pnpm test:integration",
			"pnpm test:e2e",
		]);
		expect(processes.environments.slice(1)).toStrictEqual(
			Array.from({ length: 8 }, () => ({ RBX_FORGE_TEST_REAL_STUDIO: "1" })),
		);
	});

	it("should run without real Studio on macOS and say so", () => {
		expect.assertions(3);

		const processes = fakeProcesses({ reads: CLEAN_MAIN });

		runReleaseCheck({ ...processes, platform: "darwin" });

		expect(processes.runs).toHaveLength(9);
		expect(processes.environments).toSatisfyAll((environment) => environment === undefined);
		expect(processes.logs).toContain(
			"release-check: real-Studio specs are Windows only; they skip on macOS",
		);
	});

	it("should refuse another platform", () => {
		expect.assertions(2);

		const processes = fakeProcesses({ reads: CLEAN_MAIN });

		expect(() => {
			runReleaseCheck({ ...processes, platform: "linux" });
		}).toThrow("release from Windows or macOS, not linux");
		expect(processes.runs).toBeEmpty();
	});

	it("should stop at the first failing step", () => {
		expect.assertions(2);

		const processes = fakeProcesses({ failing: ["pnpm lint"], reads: CLEAN_MAIN });

		expect(() => {
			runReleaseCheck({ ...processes, platform: "win32" });
		}).toThrow("pnpm lint exited with 1");
		expect(processes.runs.at(-1)).toBe("pnpm lint");
	});

	it.for([
		{
			message: "release from main, not feature",
			reads: { ...CLEAN_MAIN, "git branch --show-current": "feature\n" },
		},
		{
			message: "release from main, not a detached HEAD",
			reads: { ...CLEAN_MAIN, "git branch --show-current": "" },
		},
		{
			message: "the working tree has changes",
			reads: { ...CLEAN_MAIN, "git status --porcelain": " M package.json\n" },
		},
		{
			message: "HEAD is not origin/main; pull or push first",
			reads: { ...CLEAN_MAIN, "git rev-parse origin/main": "def\n" },
		},
	])("should refuse with $message", ({ message, reads }) => {
		expect.assertions(2);

		const processes = fakeProcesses({ reads });

		expect(() => {
			runReleaseCheck({ ...processes, platform: "win32" });
		}).toThrow(message);
		expect(processes.runs.filter((line) => line.startsWith("pnpm"))).toBeEmpty();
	});

	it("should throw when git cannot run", () => {
		expect.assertions(1);

		const processes = fakeProcesses();

		expect(() => {
			runReleaseCheck({ ...processes, platform: "win32" });
		}).toThrow("git branch --show-current exited with 1");
	});
});

describe(publishRelease, () => {
	it("should publish every platform package, then the root package", () => {
		expect.assertions(2);

		const { dependencies, processes } = publishSetup();
		publishRelease(dependencies, { ...OPTIONS, tag: "latest", version: "1.0.0" });

		expect(processes.runs).toHaveLength(NATIVE_TARGETS.length * 2 + 1);
		expect(processes.runs).toStrictEqual([
			...NATIVE_TARGETS.flatMap(({ target }) => {
				const tarball = path.join("staging", `rbx-forge-native-${target}-1.0.0.tgz`);
				return [
					`pnpm --dir ${path.join("staging", target)} pack --pack-destination ..`,
					`pnpm publish ${tarball} ${FLAGS} --tag latest`,
				];
			}),
			`pnpm publish repo ${FLAGS} --tag latest`,
		]);
	});

	it("should stage the addon, the reaper, the license, and a manifest", () => {
		expect.assertions(4);

		const { contents, dependencies } = publishSetup();
		publishRelease(dependencies, { ...OPTIONS, tag: "latest", version: "1.0.0" });

		const directory = path.join("staging", "darwin-arm64");

		expect(contents.get(path.join(directory, "forge-native.darwin-arm64.node"))).toBe("addon");
		expect(contents.get(path.join(directory, "forge-reaper"))).toBe("reaper");
		expect(contents.get(path.join(directory, "LICENSE"))).toBe("MIT");
		expect(JSON.parse(contents.get(path.join(directory, "package.json"))!)).toMatchObject({
			name: "@rbx-forge/native-darwin-arm64",
			version: "1.0.0",
		});
	});

	it.for([
		{ entry: 0, target: "darwin-arm64" },
		{ entry: 1, target: "win32-x64-msvc" },
	])("should publish an executable reaper for $target", ({ entry, target }) => {
		expect.assertions(1);

		const { bytes, dependencies } = publishSetup();
		publishRelease(dependencies, { ...OPTIONS, tag: "latest", version: "1.0.0" });

		const tarball = bytes.get(path.join("staging", `rbx-forge-native-${target}-1.0.0.tgz`));

		expect(entryMode(tarball!, entry)).toBe("0000755");
	});

	it("should publish the root with the platform packages as optional dependencies, then restore it", () => {
		expect.assertions(3);

		const { contents, dependencies, writes } = publishSetup();
		const manifests: Array<string> = [];
		const { run } = dependencies;
		publishRelease(
			{
				...dependencies,
				run: (command, args, environment) => {
					manifests.push(contents.get(path.join("repo", "package.json"))!);
					return run(command, args, environment);
				},
			},
			{ ...OPTIONS, tag: "next", version: "1.1.0-rc.0" },
		);

		const published: unknown = JSON.parse(manifests.at(-1)!);

		expect(published).toMatchObject({
			optionalDependencies: { "@rbx-forge/native-win32-x64-msvc": "1.1.0-rc.0" },
			version: "1.1.0-rc.0",
		});
		expect(writes.at(-1)).toBe(path.join("repo", "package.json"));
		expect(contents.get(path.join("repo", "package.json"))).toBe(ROOT_MANIFEST);
	});

	it("should skip a package already on npm at this version", () => {
		expect.assertions(2);

		const { dependencies, processes } = publishSetup({
			"npm view @rbx-forge/native-win32-x64-msvc@1.0.0 version --loglevel=silent": "1.0.0\n",
		});
		publishRelease(dependencies, { ...OPTIONS, tag: "latest", version: "1.0.0" });

		expect(processes.runs).toHaveLength((NATIVE_TARGETS.length - 1) * 2 + 1);
		expect(processes.logs).toStrictEqual([
			"release: @rbx-forge/native-win32-x64-msvc@1.0.0 is on npm; skipped",
		]);
	});

	it("should name every missing artifact and publish nothing", () => {
		expect.assertions(2);

		const { contents, dependencies, processes } = publishSetup();
		const addon = path.join(
			"artifacts",
			"native-aarch64-apple-darwin",
			"napi",
			"forge-native.darwin-arm64.node",
		);
		contents.delete(addon);

		expect(() => {
			publishRelease(dependencies, { ...OPTIONS, tag: "latest", version: "1.0.0" });
		}).toThrow(`missing native artifacts:\n${addon}`);
		expect(processes.runs).toBeEmpty();
	});

	it("should restore the root manifest when its publish fails", () => {
		expect.assertions(2);

		const { contents, dependencies } = publishSetup({}, [
			"pnpm publish repo --access public --no-git-checks --tag latest",
		]);

		expect(() => {
			publishRelease(dependencies, { ...OPTIONS, tag: "latest", version: "1.0.0" });
		}).toThrow("pnpm publish repo --access public --no-git-checks --tag latest exited with 1");
		expect(contents.get(path.join("repo", "package.json"))).toBe(ROOT_MANIFEST);
	});
});

describe(bootstrapRelease, () => {
	it("should download the CI artifacts for HEAD, build, and publish on next", () => {
		expect.assertions(2);

		const { dependencies, processes, removed } = publishSetup(BOOTSTRAP_READS);
		bootstrapRelease(dependencies, { ...OPTIONS, version: "1.0.0-rc.0" });

		expect(removed[0]).toBe("artifacts");
		expect(processes.runs.slice(0, 3)).toStrictEqual([
			"gh run download 42 --repo owner/forge --pattern native-* --dir artifacts",
			"pnpm build",
			`pnpm --dir ${path.join("staging", "win32-x64-msvc")} pack --pack-destination ..`,
		]);
	});

	it("should refuse a stable version", () => {
		expect.assertions(1);

		const { dependencies } = publishSetup(BOOTSTRAP_READS);

		expect(() => {
			bootstrapRelease(dependencies, { ...OPTIONS, version: "1.0.0" });
		}).toThrow("bootstrap publishes a prerelease only, not 1.0.0");
	});

	it("should refuse a dirty working tree", () => {
		expect.assertions(1);

		const { dependencies } = publishSetup({
			...BOOTSTRAP_READS,
			"git status --porcelain": "?? x",
		});

		expect(() => {
			bootstrapRelease(dependencies, { ...OPTIONS, version: "1.0.0-rc.0" });
		}).toThrow("the working tree has changes");
	});

	it.for([
		{ stdout: "null\n", what: "no run" },
		{ stdout: "", what: "nothing" },
	])("should refuse when gh lists $what", ({ stdout }) => {
		expect.assertions(1);

		const { dependencies } = publishSetup({ ...BOOTSTRAP_READS, [RUN_LIST]: stdout });

		expect(() => {
			bootstrapRelease(dependencies, { ...OPTIONS, version: "1.0.0-rc.0" });
		}).toThrow("no successful CI run for abc; push it and wait for CI");
	});

	it.for([
		{ repository: undefined, what: "no repository" },
		{ repository: "https://gitlab.com/owner/forge", what: "a repository off GitHub" },
	])("should refuse a package.json with $what", ({ repository }) => {
		expect.assertions(1);

		const { contents, dependencies } = publishSetup(BOOTSTRAP_READS);
		contents.set(
			path.join("repo", "package.json"),
			JSON.stringify({ name: "rbx-forge", repository, version: "1.0.0" }),
		);

		expect(() => {
			bootstrapRelease(dependencies, { ...OPTIONS, version: "1.0.0-rc.0" });
		}).toThrow("package.json#repository names no GitHub repository");
	});

	it("should take the repository from a string", () => {
		expect.assertions(1);

		const { contents, dependencies, processes } = publishSetup({
			...BOOTSTRAP_READS,
			[RUN_LIST.replace("owner/forge", "other/tool")]: "7\n",
		});
		contents.set(
			path.join("repo", "package.json"),
			JSON.stringify({
				name: "rbx-forge",
				repository: "github:other/tool",
				version: "1.0.0",
			}),
		);
		bootstrapRelease(dependencies, { ...OPTIONS, version: "1.0.0-rc.0" });

		expect(processes.runs[0]).toBe(
			"gh run download 7 --repo other/tool --pattern native-* --dir artifacts",
		);
	});

	it("should throw when the download fails", () => {
		expect.assertions(1);

		const { dependencies } = publishSetup(BOOTSTRAP_READS);
		const failing = { ...dependencies, run: () => 1 };

		expect(() => {
			bootstrapRelease(failing, { ...OPTIONS, version: "1.0.0-rc.0" });
		}).toThrow(
			"gh run download 42 --repo owner/forge --pattern native-* --dir artifacts exited with 1",
		);
	});
});
