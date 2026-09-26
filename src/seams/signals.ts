/**
 * The signals that end a session: Ctrl+Break, a closed terminal, Ctrl+C,
 * and `kill`.
 */
export const STOP_SIGNALS: ReadonlyArray<NodeJS.Signals> = [
	"SIGBREAK",
	"SIGHUP",
	"SIGINT",
	"SIGTERM",
];

/**
 * Requests to stop the forge process. While a listener is on, the signals no
 * longer end the process: the listener decides. Unit tests pass a fake.
 */
export interface Signals {
	/**
	 * Call `listener` for every stop signal until the returned function
	 * removes it.
	 */
	onStop: (listener: (signal: NodeJS.Signals) => void) => () => void;
}

/** Where signals arrive: the Node process. */
export type SignalSource = Pick<NodeJS.Process, "off" | "on">;

/**
 * Stop signals from a process.
 *
 * @param source - The process (`node:process`).
 * @returns The seam.
 */
export function createSignals(source: SignalSource): Signals {
	return {
		onStop: (listener) => {
			for (const signal of STOP_SIGNALS) {
				source.on(signal, listener);
			}

			return () => {
				for (const signal of STOP_SIGNALS) {
					source.off(signal, listener);
				}
			};
		},
	};
}
