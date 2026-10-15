import type { Capture, CaptureListener } from "../../src/capture/protocol.ts";

/**
 * A plugin at the network seam, supplying captures without Studio.
 * @param capture - The next capture or rejection.
 * @returns The fake listener.
 */
export function createFakeCapture(capture: Capture | Error): CaptureListener {
	const closed = new AbortController();
	return {
		captureAsync: async (signal) => {
			await Promise.resolve();
			signal.throwIfAborted();
			closed.signal.throwIfAborted();
			if (capture instanceof Error) {
				throw capture;
			}

			return capture;
		},
		close: () => {
			closed.abort();
		},
		url: "http://127.0.0.1:12345/capture/test?projectName=project&sessionId=session",
	};
}
