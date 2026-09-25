/** Milliseconds from 1601-01-01 (the `FILETIME` epoch) to 1970-01-01. */
const FILETIME_EPOCH_OFFSET_MS = 11_644_473_600_000n;
/** `FILETIME` counts 100 ns intervals. */
const FILETIME_TICKS_PER_MS = 10_000n;
const MICROSECONDS_PER_MS = 1000n;
/**
 * Milliseconds per Linux clock tick. `/proc/<pid>/stat` counts start time in
 * `USER_HZ` ticks, which is 100 on every architecture forge ships for.
 */
const LINUX_MS_PER_TICK = 10;

/** Per OS: the addon's start time to milliseconds since the Unix epoch. */
const TO_EPOCH_MS: Partial<
	Record<NodeJS.Platform, (startTime: string, bootTimeMs: number) => number>
> = {
	darwin: (startTime) => Number(BigInt(startTime) / MICROSECONDS_PER_MS),
	linux: (startTime, bootTimeMs) => bootTimeMs + Number(startTime) * LINUX_MS_PER_TICK,
	win32: (startTime) => {
		return Number(BigInt(startTime) / FILETIME_TICKS_PER_MS - FILETIME_EPOCH_OFFSET_MS);
	},
};

/**
 * Turn a start time from the addon (`processStartTime`,
 * `PinnedProcess.startTime`) into milliseconds since the Unix epoch, so it
 * can be compared with file times.
 *
 * @param startTime - The addon's start time: a Windows `FILETIME`, Linux
 *   clock ticks since boot, or macOS microseconds since the Unix epoch.
 * @param platform - The OS the addon ran on.
 * @param bootTimeMs - When the OS booted, in milliseconds since the Unix
 *   epoch. Used on Linux only.
 * @returns The start time, or `undefined` on an OS the addon does not
 *   support.
 */
export function startTimeToEpochMs(
	startTime: string,
	platform: NodeJS.Platform,
	bootTimeMs: number,
): number | undefined {
	return TO_EPOCH_MS[platform]?.(startTime, bootTimeMs);
}
