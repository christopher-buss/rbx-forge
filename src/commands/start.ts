import type { FlagDefinition } from "../cli/flags.ts";
import type { CommandResult } from "../seams/reporter.ts";
import type { CommandContext, CommandInput } from "./context.ts";

export const START_FLAGS: ReadonlyArray<FlagDefinition> = [
	{
		name: "compiler",
		kind: "boolean",
		text: "Compile, build, and run the compiler in watch mode (the default); --no-compiler runs none of them.",
	},
	{
		name: "force",
		kind: "boolean",
		text: "Kill what is left of an earlier session when it outlives the wait, verified as the session's own.",
	},
	{
		name: "open",
		kind: "boolean",
		text: "Open the place in Studio and stop when Studio closes it (the default); --no-open leaves Studio alone.",
	},
	{
		name: "syncback",
		config: "syncback.runOnStart",
		kind: "boolean",
		text: "Run syncback and its hooks each time Studio saves the place.",
	},
];

/**
 * `forge start`: run the dev session in this terminal (spec #28): compile and
 * build, open Studio, serve Rojo, run the compiler in watch mode, and, with
 * `--syncback`, sync Studio's saves back.
 *
 * The session runs in a separate supervisor process
 * (`supervisor/run-supervisor.ts`), bound to this one by the owner pipe: when
 * this process dies, however it dies, the supervisor stops the session.
 * Stop signals this process gets are passed on, and the supervisor's
 * progress is reported here.
 *
 * @param context - The run: project root, environment, seams, and reporter.
 * @param input - The parsed flags.
 * @returns The stop reason and every worker's report, once all are gone.
 * @rejects The session's failure (see `runSupervisorAsync`),
 *   such as `session_running` when a session already runs for the project.
 */
export async function runStartAsync(
	{ cwd, env, reporter, seams }: CommandContext,
	input: CommandInput,
): Promise<CommandResult> {
	const run = seams.supervisor({
		cwd,
		env,
		onEvent: (event) => {
			reporter.emit(event);
		},
		request: {
			compiler: input.flags["compiler"] !== false,
			config: input.config,
			open: input.flags["open"] !== false,
			...(input.flags["force"] === true ? { force: true } : {}),
		},
	});
	const dispose = seams.signals.onStop(run.stop);
	try {
		return await run.result;
	} finally {
		dispose();
	}
}
