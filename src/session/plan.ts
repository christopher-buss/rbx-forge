import type { ResolvedConfig } from "../config/resolve.ts";
import { ForgeError } from "../errors.ts";
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
	/** The Rojo serve service. */
	rojo: boolean;
	/** Run syncback on every place save. */
	syncback: boolean;
}

/**
 * The session flags: `--no-compiler`, `--no-open`, and `--no-rojo` turn these
 * off.
 */
export interface SessionFlags {
	compiler: boolean;
	open: boolean;
	rojo: boolean;
}

/** The compiler's watch flag; roblox-ts reads it. */
const WATCH_FLAG = "-w";

export const COMPILER_MISSING_HINT =
	"Install roblox-ts in the project (npm install --save-dev roblox-ts), or set rbxts.command.";

const LUAU_MISSING_HINT = "Install it, or fix luau.watch.command in the config.";

/**
 * Decide what a session runs: Rojo serve unless `--no-rojo`; the
 * compiler in watch mode unless `--no-compiler`; Studio unless `--no-open`;
 * syncback on save with `--syncback` or `syncback.runOnStart`. A session with
 * a compiler compiles (roblox-ts) and builds once before its services start.
 *
 * @param config - The resolved config; the flags already set its values.
 * @param flags - Whether `--compiler`, `--open`, and `--rojo` are on.
 * @returns What the session runs, in order.
 * @throws {ForgeError} `usage` when the session would run no service.
 */
export function planSession(config: ResolvedConfig, flags: SessionFlags): SessionPlan {
	const compiler = flags.compiler ? compilerWatch(config) : undefined;
	if (compiler === undefined && !flags.rojo) {
		throw new ForgeError("usage", "With --no-rojo, the session runs no service.", {
			hint: flags.compiler
				? "Drop --no-rojo, or set luau.watch.command in the config."
				: "Drop --no-rojo or --no-compiler.",
		});
	}

	return {
		build: compiler !== undefined,
		compile: compiler !== undefined && config.projectType === "rbxts",
		compiler,
		open: flags.open,
		rojo: flags.rojo,
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
