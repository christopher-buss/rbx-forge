/**
 * Generic command interface for type-safe command registration.
 *
 * @template Options - The type of options this command accepts (void for no
 *   options).
 */
export interface Command<Options = void> {
	action: Options extends void ? () => Promise<void> : (options: Options) => Promise<void>;
	// eslint-disable-next-line flawless/naming-convention -- CLI convention requires uppercase COMMAND export
	COMMAND: string;
	// eslint-disable-next-line flawless/naming-convention -- CLI convention requires uppercase DESCRIPTION export
	DESCRIPTION: string;
	options?: ReadonlyArray<{
		description: string;
		flags: string;
	}>;
}

/**
 * Helper type for commands with options.
 *
 * @template Options - The type of options this command accepts.
 */
export type CommandWithOptions<Options> = Command<Options>;

/** Helper type for commands without options. */
export type SimpleCommand = Command;
