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
	/** The watch-mode compiler service; none for Rojo only. */
	compiler: CompilerWatch | undefined;
	/** Open the place in Studio; the session ends when Studio closes it. */
	open: boolean;
	/** Run syncback on every place save. */
	syncback: boolean;
}

/** The session flags: `--no-compiler` and `--no-open` turn these off. */
export interface SessionFlags {
	compiler: boolean;
	open: boolean;
}

/** The compiler's watch flag; roblox-ts reads it. */
const WATCH_FLAG = "-w";

export const COMPILER_MISSING_HINT =
	"Install roblox-ts in the project (npm install --save-dev roblox-ts), or set rbxts.command.";

const LUAU_MISSING_HINT = "Install it, or fix luau.watch.command in the config.";

/**
 * Decide what a session runs (spec #28, Session lifecycle): Rojo always; the
 * compiler in watch mode unless `--no-compiler`; Studio unless `--no-open`;
 * syncback on save with `--syncback` or `syncback.runOnStart`. A session with
 * a compiler compiles (roblox-ts) and builds once before its services start.
 *
 * @param config - The resolved config; the flags already set its values.
 * @param flags - Whether `--compiler` and `--open` are on.
 * @returns What the session runs, in order.
 */
export function planSession(config: ResolvedConfig, flags: SessionFlags): SessionPlan {
	const compiler = flags.compiler ? compilerWatch(config) : undefined;
	return {
		build: compiler !== undefined,
		compile: compiler !== undefined && config.projectType === "rbxts",
		compiler,
		open: flags.open,
		syncback: config.syncback.runOnStart,
	};
}

/**
 * The watch-mode compiler of a project: `rbxtsc -w` for roblox-ts, the
 * configured watch command for Luau (none when no command is set).
 *
 * @param config - The project type and compiler options.
 * @returns The compiler service, or `undefined` when there is none.
 */
function compilerWatch(
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
