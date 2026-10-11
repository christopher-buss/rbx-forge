import type { CommandContext } from "../commands/context.ts";
import { ForgeError } from "../errors.ts";
import { logFilePath } from "../output/log-file.ts";
import { settlesWithinAsync } from "../seams/clock.ts";
import type { BuildWatch } from "./build-watch.ts";
import { FRESH_BUILD_TIMEOUT_MS } from "./build-watch.ts";
import type { PartAdder } from "./part-requests.ts";
import type { SessionScope } from "./run-session.ts";
import type {
	RunningPart,
	ServiceHooks,
	ServiceInvocation,
	ServiceParts,
} from "./service-parts.ts";
import type { PartId } from "./status.ts";

/** The watch-mode compiler service of a session, resolved. */
export interface CompilerService {
	/** Read its output as roblox-ts builds. */
	parsesDiagnostics: boolean;
	service: ServiceInvocation;
}

/** What the compiler's part runs with. */
export interface CompilerSetup {
	/** Reads the compiler's builds, for `status` and `status --wait`. */
	builds: Pick<BuildWatch, "fail" | "read" | "restart">;
	/** The command's context: project root and reporter. */
	context: CommandContext;
}

/** What adds parts to a running session. */
export interface AdderSetup extends CompilerSetup {
	/**
	 * Resolve the project's compiler now, so a compiler installed since the
	 * session started is found.
	 *
	 * @throws {ForgeError} `compiler_missing`.
	 */
	resolveCompiler: () => CompilerService | undefined;
}

/**
 * Start the watch-mode compiler as its part. A compiler that reports
 * compiles is `starting` until its first build, and its builds are read
 * from a fresh start; one whose first build does not end within
 * {@link FRESH_BUILD_TIMEOUT_MS} is stopped as `failed`. Any other compiler
 * is `ready` once it runs.
 *
 * @param setup - The builds and reporter.
 * @param scope - Tracks the wait for its first build.
 * @param parts - Starts the part.
 * @param compiler - The resolved compiler.
 * @returns Its running part, or `undefined` when the session is ending.
 * @rejects As {@link ServiceParts.startAsync}.
 */
export async function startCompilerAsync(
	setup: CompilerSetup,
	scope: Pick<SessionScope, "track">,
	parts: Pick<ServiceParts, "startAsync" | "stop">,
	compiler: CompilerService,
): Promise<RunningPart | undefined> {
	if (!compiler.parsesDiagnostics) {
		return parts.startAsync(compiler.service, { initial: "ready" });
	}

	setup.builds.restart();
	const firstBuild = Promise.withResolvers<void>();
	const part = await parts.startAsync(compiler.service, {
		...compileReader(setup, firstBuild.resolve),
		initial: "starting",
	});
	if (part !== undefined) {
		scope.track(failSlowFirstBuildAsync(setup, parts, firstBuild.promise));
	}

	return part;
}

/**
 * Add the parts a client asks for that are missing or failed: first the
 * compiler, when the project has one and it does not run; then Studio and
 * its Rojo, through `addStudio`. A part that runs is never touched.
 *
 * @param setup - The builds, reporter, and compiler resolution.
 * @param scope - Tracks each compiler's wait for its first build.
 * @param parts - The session's service parts.
 * @param addStudio - Adds Studio and Rojo, once the compiler runs.
 * @returns The adder the control channel calls.
 */
export function createPartAdder(
	setup: AdderSetup,
	scope: Pick<SessionScope, "track">,
	parts: Pick<ServiceParts, "isRunning" | "startAsync" | "stop">,
	addStudio: PartAdder,
): PartAdder {
	return async (request) => {
		const added: Array<PartId> = [];
		const compiler =
			request.parts.includes("compiler") && !parts.isRunning("compiler")
				? setup.resolveCompiler()
				: undefined;
		const part =
			compiler === undefined
				? undefined
				: await startCompilerAsync(setup, scope, parts, compiler);
		if (part !== undefined) {
			added.push("compiler");
		}

		return [...added, ...(await addStudio(request))];
	};
}

/**
 * Stop the compiler as `failed` when its first build does not end in time;
 * every wait for a build then fails with `compile_timeout`.
 *
 * @param setup - The clock and builds.
 * @param parts - Stops the part.
 * @param firstBuild - Resolves on its first build, or once it stopped.
 */
async function failSlowFirstBuildAsync(
	setup: CompilerSetup,
	parts: Pick<ServiceParts, "stop">,
	firstBuild: Promise<void>,
): Promise<void> {
	const { clock } = setup.context.seams;
	if (await settlesWithinAsync(clock, firstBuild, FRESH_BUILD_TIMEOUT_MS)) {
		return;
	}

	const why = `The compiler's first build did not end within ${FRESH_BUILD_TIMEOUT_MS / 1000} s`;
	// The first failure wins: the stop's own failure does not replace it.
	setup.builds.fail(
		new ForgeError("compile_timeout", `${why}.`, {
			hint: 'Read its output with "forge logs compiler".',
		}),
	);
	parts.stop("compiler", why);
}

/**
 * Read the watch-mode compiler's output as builds, and report each one. Once
 * the compiler stops, every wait for a build fails until one starts again.
 *
 * @param setup - The session's builds and reporter.
 * @param settled - Called on each build, and once it stopped.
 * @returns What its service reads each line with, and does once it stopped.
 */
function compileReader(
	setup: CompilerSetup,
	settled: () => void,
): Pick<ServiceHooks, "onLine" | "onStopped"> {
	return {
		onLine: (line) => {
			const build = setup.builds.read(line);
			if (build !== undefined) {
				settled();
				const { diagnostics, errors } = build;
				setup.context.reporter.emit({ diagnostics, errors, type: "compiled" });
			}
		},
		onStopped: () => {
			settled();
			setup.builds.fail(
				new ForgeError("service_failed", "The compiler stopped, so no build comes.", {
					details: { reason: "service_failed:compiler" },
					hint: `Its output is in ${logFilePath(setup.context.cwd, "compiler")}.`,
				}),
			);
		},
	};
}
