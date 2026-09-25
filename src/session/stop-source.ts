/** Why a session stops before it ends on its own. */
export type StopRequest =
	/**
	 * A stop signal (Ctrl+C, `kill`, a closed terminal), or one that `start`
	 * passed on.
	 */
	| { signal: NodeJS.Signals; type: "signal" }
	/**
	 * The owner pipe closed: `forge start` is gone (killed, or its terminal
	 * closed).
	 */
	| { type: "owner_gone" }
	/** A client asked the session to stop over its control channel. */
	| { type: "shutdown" };

/** Calls `listener` once, on the first stop request; returns its removal. */
export type OnStop = (listener: (request: StopRequest) => void) => () => void;

/**
 * The one place a supervisor learns that it must stop. The owner pipe and
 * the stop signals feed it from the supervisor's first instruction, before
 * anything listens, so a request is never lost: a listener added later gets
 * the request at once.
 */
export interface StopSource {
	onStop: OnStop;
	/** The first request, or `undefined` while none came. */
	reason: () => StopRequest | undefined;
	/** Stop. The first request wins; later ones do nothing. */
	request: (request: StopRequest) => void;
	/** Aborts on the first request. */
	signal: AbortSignal;
}

/**
 * A stop source with no request yet.
 *
 * @returns Its listeners, request, and abort signal.
 */
export function createStopSource(): StopSource {
	const abort = new AbortController();
	const listeners = new Set<(request: StopRequest) => void>();
	let first: StopRequest | undefined;

	return {
		onStop: (listener) => {
			if (first !== undefined) {
				listener(first);
				return () => {
					// Already called; nothing to remove.
				};
			}

			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		reason: () => first,
		request: (request) => {
			if (first !== undefined) {
				return;
			}

			first = request;
			abort.abort();
			for (const listener of listeners) {
				listener(request);
			}
		},
		signal: abort.signal,
	};
}
