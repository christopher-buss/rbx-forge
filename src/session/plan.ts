import type { ResolvedConfig } from "../config/resolve.ts";
import type { ToolProbe } from "../process/run-tool.ts";

/** The compiler a session runs in watch mode. */
export interface CompilerWatch {
	/** The watch command and its arguments. */
	call: ToolProbe;
	/** Read its output as roblox-ts diagnostics. */
	parsesDiagnostics: boolean;
}

/** What one session does, in order. */
export interface SessionPlan {
	/** Build the place once before the services start. */
	build: boolean;
	/** Compile once before the build (roblox-ts only). */
	compile: boolean;
	/** The watch-mode compiler service it starts; none without one. */
	compiler: CompilerWatch | undefined;
	/** Open the place in Studio, and serve Rojo: Rojo runs only with Studio. */
	open: boolean;
	/** Run syncback on every place save. */
	syncback: boolean;
}

/** The parts a session starts with. */
export interface SessionFlags {
	/** `--no-compiler` turns it off. */
	compiler: boolean;
	/**
	 * Studio with its Rojo: `start --no-open` and `up` leave it off.
	 */
	open: boolean;
}

/** The compiler's watch flag; roblox-ts reads it. */
const WATCH_FLAG = "-w";

export const COMPILER_MISSING_HINT =
	"Install roblox-ts in the project (npm install --save-dev roblox-ts), or set rbxts.command.";

const LUAU_MISSING_HINT = "Install it, or fix luau.watch.command in the config.";

/**
 * The watch-mode compiler of a project: `rbxtsc -w` for roblox-ts, the
 * configured watch command for Luau (none when no command is set).
 *
 * @param config - The project type and compiler options.
 * @returns The compiler service, or `undefined` when there is none.
 */
export function compilerWatch(
	config: Pick<ResolvedConfig, "luau" | "projectType" | "rbxts">,
): CompilerWatch | undefined {
	if (config.projectType === "rbxts") {
		return {
			call: {
				args: [...config.rbxts.args, WATCH_FLAG],
				command: config.rbxts.command,
				label: "The compiler",
				missing: "compiler_missing",
				missingHint: COMPILER_MISSING_HINT,
			},
			parsesDiagnostics: true,
		};
	}

	const { args, command } = config.luau.watch;
	if (command === undefined) {
		return undefined;
	}

	return {
		call: {
			args,
			command,
			label: "The Luau watch command",
			missing: "compiler_missing",
			missingHint: LUAU_MISSING_HINT,
		},
		parsesDiagnostics: false,
	};
}

/**
 * Decide what a session runs: the compiler in watch mode unless
 * `--no-compiler`; Studio with its Rojo as the flags ask; syncback on save
 * with `--syncback` or `syncback.runOnStart`. A session with a compiler and
 * Studio compiles (roblox-ts) and builds once before its services start; a
 * compiler alone does its first compile in watch mode.
 *
 * @param config - The resolved config; the flags already set its values.
 * @param flags - The parts it starts with.
 * @returns What the session runs, in order.
 */
export function planSession(config: ResolvedConfig, flags: SessionFlags): SessionPlan {
	const compiler = flags.compiler ? compilerWatch(config) : undefined;
	const hasBuild = compiler !== undefined && flags.open;
	return {
		build: hasBuild,
		compile: hasBuild && config.projectType === "rbxts",
		compiler,
		open: flags.open,
		syncback: config.syncback.runOnStart,
	};
}
