/**
 * What `forge` exits with. One module, so every failure class keeps one stable
 * number that scripts and agents can branch on.
 */

/** The command did what was asked. */
export const EXIT_SUCCESS = 0;
/** The command line could not be read: unknown flag or command. */
export const EXIT_USAGE = 2;

export type ExitCode = typeof EXIT_SUCCESS | typeof EXIT_USAGE;
