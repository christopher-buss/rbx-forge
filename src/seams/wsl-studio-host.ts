// cspell:words wslpath
/* oxlint-disable typescript/require-await -- Async Studio-host methods also wrap constant platform capabilities. */
import { type } from "arktype";
import path from "node:path";

import { ForgeError } from "../errors.ts";
import type { HelperClient } from "../native/helper-client.ts";
import { readVariable } from "../process/environment.ts";
import { STUDIO_OPEN_BOUND_MS } from "../session/studio-readiness.ts";
import type { StudioExecutable } from "../studio/discover.ts";
import type { KeepHiddenLauncher } from "../studio/keep-hidden.ts";
import { studioArguments } from "../studio/launch-arguments.ts";
import type { StudioLaunch, StudioLaunchOutcome } from "../studio/launcher.ts";
import { KEEP_HIDDEN_POLL_MS } from "../studio/window-hiding.ts";
import { commandExecutable, STUDIO_REGISTRY_KEYS } from "./addon-studio/discover.ts";
import type { Environment, Seams } from "./seams.ts";
import type { PinnedStudio, StudioHost } from "./studio-host.ts";
import { convertedOutput, launched, pinnedIdentity } from "./wsl-helper-results.ts";
import { createWslStudioPin } from "./wsl-studio-pin.ts";

const INVALID_PATH = /[\r\n\0]/;
const NULLABLE_TEXT = type("string | null");
const PATHS = type("string[]");
const windowsAbsolute = /^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/i;

type WslBackend = Pick<Seams, "clock" | "fileSystem" | "processRunner"> & {
	cwd: string;
	environment: Environment;
	keepHidden?: KeepHiddenLauncher;
};

class WslHost {
	private readonly backend: WslBackend;
	private readonly connect: () => HelperClient;

	private channel: HelperClient | undefined;

	constructor(backend: WslBackend, connect: () => HelperClient) {
		this.backend = backend;
		this.connect = connect;
	}

	public host(): StudioHost {
		return {
			autoSaveDirectoriesAsync: this.autoSaveDirectoriesAsync.bind(this),
			findStudioExecutableAsync: this.discoverAsync.bind(this),
			fromHostPathAsync: async (file) => this.convertAsync(file, false),
			frontmostApplicationAsync: async () => null,
			hostnameAsync: async () => {
				const identity = await this.client().identity;
				return identity.hostname;
			},
			launchAsync: this.launchAsync.bind(this),
			pinProcessAsync: this.pinProcessAsync.bind(this),
			platformAsync: async () => "win32",
			pluginsFolderAsync: async () => {
				const folder = await this.requestAsync({ op: "pluginsFolder" }, type("string"));
				return this.convertAsync(folder, false, false);
			},
			probeHttpAsync: this.probeHttpAsync.bind(this),
			processStartTimeAsync: async (pid) => {
				return this.requestAsync({ op: "processStartTime", pid }, NULLABLE_TEXT);
			},
			toHostPathAsync: async (file) => this.convertAsync(file, true),
			tryLockFileAsync: async () => {
				throw new ForgeError(
					"windows_helper_unavailable",
					"Windows singleton locking is not supported by the tracer.",
				);
			},
		};
	}

	private async autoSaveDirectoriesAsync(): Promise<Array<string>> {
		const directories = await this.requestAsync({ op: "autoSaveDirectories" }, PATHS);
		return Promise.all(
			directories.map(async (directory) => this.convertAsync(directory, false, false)),
		);
	}

	private async checkedAsync(
		file: string,
		source: StudioExecutable["source"],
	): Promise<StudioExecutable> {
		const linux = windowsAbsolute.test(file) ? await this.convertAsync(file, false) : file;
		if (
			!path.posix.isAbsolute(linux) ||
			INVALID_PATH.test(linux) ||
			!this.backend.fileSystem.existsSync(linux) ||
			!this.backend.fileSystem.statSync(linux).isFile()
		) {
			throw new ForgeError(
				"studio_launch_failed",
				`Studio executable is not an absolute file: ${file}`,
			);
		}

		return { path: linux, source };
	}

	private client(): HelperClient {
		this.channel ??= this.connect();
		return this.channel;
	}

	private async convertAsync(input: string, windows: boolean, mustExist = true): Promise<string> {
		if (
			INVALID_PATH.test(input) ||
			!(windows ? path.posix.isAbsolute(input) : windowsAbsolute.test(input))
		) {
			throw new ForgeError(
				"studio_launch_failed",
				`Expected an absolute ${windows ? "Linux" : "Windows"} path: ${input}`,
			);
		}

		if (windows && !this.backend.fileSystem.existsSync(input)) {
			throw new ForgeError("studio_launch_failed", `The Linux path is unavailable: ${input}`);
		}

		const result = await this.backend.processRunner({
			args: [windows ? "-w" : "-u", input],
			cwd: "/",
			env: this.backend.environment,
			file: "wslpath",
			timeoutMs: 10_000,
		});
		const output = convertedOutput(result, input);
		this.validateConverted(output, windows, input, mustExist);
		return output;
	}

	private async discoverAsync(options: {
		env: Environment;
		studioPath?: string | undefined;
	}): Promise<StudioExecutable | undefined> {
		const variable = readVariable(options.env, "RBX_FORGE_STUDIO_PATH", "linux");
		const explicit = options.studioPath ?? (variable === "" ? undefined : variable);

		if (explicit !== undefined) {
			return this.checkedAsync(
				explicit,
				options.studioPath === undefined ? "environment" : "flag",
			);
		}

		return this.installedAsync();
	}

	private async installedAsync(): Promise<StudioExecutable | undefined> {
		for (const key of STUDIO_REGISTRY_KEYS) {
			const command = await this.requestAsync({ key, op: "readRegistry" }, NULLABLE_TEXT);
			const file = command === null ? undefined : commandExecutable(command);
			if (file !== undefined) {
				try {
					return await this.checkedAsync(file, "registry");
				} catch (err) {
					if (!(err instanceof ForgeError) || err.code !== "studio_launch_failed") {
						throw err;
					}
				}
			}
		}

		return undefined;
	}

	private async launchAsync(launch: StudioLaunch): Promise<StudioLaunchOutcome> {
		const executable = await this.discoverAsync(launch);
		if (executable === undefined) {
			throw new ForgeError(
				"studio_launch_failed",
				"Windows Studio was not found. Set --studio-path.",
			);
		}

		const program = await this.convertAsync(executable.path, true);
		const place = await this.convertAsync(launch.place, true);
		const cwd = await this.convertAsync(launch.cwd, true);
		const runScript =
			launch.runScript === undefined
				? undefined
				: await this.convertAsync(launch.runScript, true);
		await launch.beforeLaunch?.();
		const result = await this.client().requestAsync({
			args: studioArguments({ place, runScript }),
			cwd,
			desktop: launch.runScript === undefined ? launch.desktop : "user",
			env: {},
			hiddenWindows: launch.runScript !== undefined && launch.desktop === "hidden",
			op: "launch",
			program,
		});
		const outcome = launched(result, launch.desktop ?? "user");
		await this.watchLaunchAsync(launch, result);

		return outcome;
	}

	private async pinProcessAsync(pid: number, startTime?: string): Promise<null | PinnedStudio> {
		const current = await this.requestAsync({ op: "processStartTime", pid }, NULLABLE_TEXT);
		if (current === null || (startTime !== undefined && current !== startTime)) {
			return null;
		}

		return createWslStudioPin(
			await this.client().requestAsync({ op: "pin", pid, startTime: current }),
			this.requestAsync.bind(this),
			this.backend.clock,
			this.startHidingAsync.bind(this),
		);
	}

	private async probeHttpAsync(port: number, route: string): Promise<Uint8Array> {
		const bytes = await this.requestAsync(
			{ op: "probeHttp", port, route },
			type("(0 <= number.integer <= 255)[]"),
		);
		return new Uint8Array(bytes);
	}

	private async requestAsync<T>(
		operation: Record<string, unknown>,
		shape: { assert: (value: unknown) => T },
		timeoutMs?: number,
	): Promise<T> {
		return shape.assert(await this.client().requestAsync(operation, timeoutMs));
	}

	private async startHidingAsync(
		identity: ReturnType<typeof pinnedIdentity>,
		place = "",
	): Promise<boolean> {
		const op = { pin: identity.pin };
		if (this.backend.keepHidden === undefined) {
			return this.requestAsync({ ...op, op: "startWindowHiding" }, type("boolean"));
		}

		this.watch(identity.pid, identity.startTime, place);
		const deadline = this.backend.clock.now() + STUDIO_OPEN_BOUND_MS;
		while (!(await this.requestAsync({ ...op, op: "windowHiding" }, type("boolean")))) {
			if (this.backend.clock.now() >= deadline) {
				return false;
			}

			await this.backend.clock.sleep(KEEP_HIDDEN_POLL_MS);
		}

		return true;
	}

	private validateConverted(
		output: string,
		windows: boolean,
		input: string,
		mustExist: boolean,
	): void {
		if (
			INVALID_PATH.test(output) ||
			!(windows ? windowsAbsolute.test(output) : path.posix.isAbsolute(output))
		) {
			throw new ForgeError(
				"studio_launch_failed",
				`wslpath could not convert ${input} to an absolute path.`,
			);
		}

		if (!windows && mustExist && !this.backend.fileSystem.existsSync(output)) {
			throw new ForgeError(
				"studio_launch_failed",
				`The converted Windows path is unavailable in WSL: ${output}`,
			);
		}
	}

	private watch(pid: number, startTime: string, place: string): void {
		this.backend.keepHidden?.({
			cwd: this.backend.cwd,
			env: this.backend.environment,
			target: { isWindows: true, pid, place, startTime },
		});
	}

	private async watchLaunchAsync(launch: StudioLaunch, result: unknown): Promise<void> {
		if (launch.runScript === undefined || launch.desktop !== "hidden") {
			return;
		}

		const identity = pinnedIdentity(result);
		await this.startHidingAsync(identity, launch.place);
	}
}

/**
 * Windows Studio control through one process-local helper.
 * @param backend - Linux file, process and clock seams.
 * @param connect - Lazy connection to the packaged Windows helper.
 * @returns Windows Studio operations with Linux paths at the public boundary.
 * @rejects Invalid paths, unavailable helpers, and uncertain launches.
 */
export function createWslStudioHost(backend: WslBackend, connect: () => HelperClient): StudioHost {
	const host = new WslHost(backend, connect);
	return host.host();
}
