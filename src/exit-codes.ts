/**
 * What `forge` exits with. One module, so every failure class keeps one stable
 * number that scripts and agents can branch on. The help page lists
 * {@link EXIT_CODE_HELP}, and `errors.ts` maps each error code to one of these.
 */

/** The command did what was asked. */
export const EXIT_SUCCESS = 0;
/** The command failed: bad config, a failed tool, a declined prompt. */
export const EXIT_FAILURE = 1;
/** The command line could not be read: unknown flag, command, or value. */
export const EXIT_USAGE = 2;
/** The command needs a running session and none runs, or it was replaced. */
export const EXIT_NOT_RUNNING = 3;
/** A question had no safe default and the run cannot prompt. */
export const EXIT_NEEDS_CONFIRMATION = 4;
/** A process could not be proven to be the one meant, so none was killed. */
export const EXIT_IDENTITY_UNVERIFIED = 5;
/** Session processes still live, or the supervisor does not answer. */
export const EXIT_CLEANUP_PENDING = 6;
/** Stopped by Ctrl+C or a termination signal. */
export const EXIT_INTERRUPTED = 130;

export type ExitCode =
	| typeof EXIT_CLEANUP_PENDING
	| typeof EXIT_FAILURE
	| typeof EXIT_IDENTITY_UNVERIFIED
	| typeof EXIT_INTERRUPTED
	| typeof EXIT_NEEDS_CONFIRMATION
	| typeof EXIT_NOT_RUNNING
	| typeof EXIT_SUCCESS
	| typeof EXIT_USAGE;

/** Every exit code with its help line, in numeric order. */
export const EXIT_CODE_HELP: ReadonlyArray<readonly [ExitCode, string]> = [
	[EXIT_SUCCESS, "success"],
	[EXIT_FAILURE, "failure (config, tool, hook, or declined prompt)"],
	[EXIT_USAGE, "unreadable command line"],
	[EXIT_NOT_RUNNING, "no session is running"],
	[EXIT_NEEDS_CONFIRMATION, "needs confirmation, and the run cannot prompt"],
	[EXIT_IDENTITY_UNVERIFIED, "cannot verify a process identity; nothing was killed"],
	[EXIT_CLEANUP_PENDING, "cleanup in progress, or the supervisor does not respond"],
	[EXIT_INTERRUPTED, "interrupted"],
];
