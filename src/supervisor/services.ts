import type { CommandContext } from "../commands/context.ts";
import type { ResolvedConfig } from "../config/resolve.ts";
import { resolveInvocation } from "../process/run-tool.ts";
import { DEFAULT_ROJO_PORT } from "../rojo/rojo-port.ts";
import { rojoInvocation, rojoServeArgs } from "../rojo/rojo.ts";
import type { CompilerService } from "../session/compiler-part.ts";
import type { SessionPlan } from "../session/plan.ts";
import { compilerWatch } from "../session/plan.ts";
import type { ServiceInvocation } from "../session/service-parts.ts";
import type { SessionSetup } from "../session/session-body.ts";
import type { PartOwner } from "../session/status.ts";

/** The services of a session, resolved before it starts. */
export type SessionServices = Pick<
	SessionSetup,
	"compiler" | "config" | "context" | "owner" | "plan" | "resolveCompiler" | "resolveRojo"
>;

/**
 * Find Rojo and the compiler the session starts with before anything starts,
 * so a missing tool fails first. Rojo is resolved again on its port once
 * the session chose it.
 *
 * @param context - The project root, environment, and seams.
 * @param config - The resolved config.
 * @param start - What the session runs, and who owns it.
 * @param start.owner - The owner of the parts it starts with.
 * @param start.plan - What the session runs.
 * @returns The session, without its directory.
 * @throws `rojo_missing` or `compiler_missing`.
 */
export function resolveServices(
	context: CommandContext,
	config: ResolvedConfig,
	{ owner, plan }: { owner: null | PartOwner; plan: SessionPlan },
): SessionServices {
	/**
	 * `rojo serve` on a port.
	 *
	 * @param port - Where Rojo serves.
	 * @returns Its service.
	 * @throws `rojo_missing`.
	 */
	function resolveRojo(port: number): ServiceInvocation {
		const rojo = rojoInvocation(context, config, rojoServeArgs(config.rojoProjectPath, port));
		return { ...rojo, id: "rojo", step: "rojo serve" };
	}

	if (plan.rojo) {
		resolveRojo(config.rojoPort ?? DEFAULT_ROJO_PORT);
	}

	return {
		compiler: plan.compiler === undefined ? undefined : resolveCompiler(context, config),
		config,
		context,
		owner,
		plan,
		resolveCompiler: () => resolveCompiler(context, config),
		resolveRojo,
	};
}

/**
 * Resolve the project's watch-mode compiler.
 *
 * @param context - The project root, environment, and seams.
 * @param config - The resolved config.
 * @returns The compiler service, or `undefined` when the project has none.
 * @throws `compiler_missing`.
 */
function resolveCompiler(
	context: CommandContext,
	config: ResolvedConfig,
): CompilerService | undefined {
	const compiler = compilerWatch(config);
	if (compiler === undefined) {
		return undefined;
	}

	return {
		parsesDiagnostics: compiler.parsesDiagnostics,
		service: {
			...resolveInvocation(context, compiler.call),
			id: "compiler",
			step: `${compiler.call.command} watch`,
		},
	};
}
