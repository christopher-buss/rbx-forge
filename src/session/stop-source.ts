/** Why a session stops before it ends on its own. */
export type StopRequest =
	/**
	 * A client asked the session to stop over its control channel. `force`:
	 * `forge down` waited long enough, so the workers get no more grace.
	 */
	| { force?: true; type: "shutdown" }
	/**
	 * A stop signal (Ctrl+C, `kill`, a closed terminal), or one that `start`
	 * passed on.
	 */
	| { signal: NodeJS.Signals; type: "signal" }
	/**
	 * The owner pipe closed: `forge start` is gone (killed, or its terminal
	 * closed).
	 */
	| { type: "owner_gone" };

/** Calls `listener` once, on the first stop request; returns its removal. */
export type OnStop = (listener: (request: StopRequest) => void) => () => void;

/**
 * The one place a supervisor learns that it must stop. The owner pipe and
 * the stop signals feed it from the supervisor's first instruction, before
 * anything listens, so a request is never lost: a listener added later gets
 * the request at once.
 */
export interface StopSource {
	/**
	 * Aborts on a forced shutdown, also one that comes after the first
	 * request: the shutdown in progress stops waiting for the grace.
	 */
	hurry: AbortSignal;
	onStop: OnStop;
	/** The first request, or `undefined` while none came. */
	reason: () => StopRequest | undefined;
	/** Stop. The first request wins; later ones can only hurry. */
	request: (request: StopRequest) => void;
	/** Aborts on the first request. */
	signal: AbortSignal;
}

/** The listeners of a stop source and its first request. */
interface Requests {
	first: StopRequest | undefined;
	listeners: Set<(request: StopRequest) => void>;
}

/**
 * A stop source with no request yet.
 *
 * @returns Its listeners, request, and abort signals.
 */
export function createStopSource(): StopSource {
	const abort = new AbortController();
	const hurry = new AbortController();
	const requests: Requests = { first: undefined, listeners: new Set() };

	return {
		hurry: hurry.signal,
		onStop: (listener) => listen(requests, listener),
		reason: () => requests.first,
		request: (request) => {
			if (request.type === "shutdown" && request.force === true) {
				hurry.abort();
			}

			if (requests.first !== undefined) {
				return;
			}

			requests.first = request;
			abort.abort();
			for (const listener of requests.listeners) {
				listener(request);
			}
		},
		signal: abort.signal,
	};
}

function listen(
	{ first, listeners }: Requests,
	listener: (request: StopRequest) => void,
): () => void {
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
}
