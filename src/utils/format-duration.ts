/**
 * Format a duration from a start time to now.
 *
 * @example
 *
 * ```ts
 * const startTime = performance.now();
 * // ... do work ...
 * console.log(formatDuration(startTime)); // "1.2s"
 * ```
 *
 * @param startTime - The start time from performance.now().
 * @returns Formatted duration string (e.g., "1.2s").
 */
export function formatDuration(startTime: number): string {
	const endTime = performance.now();
	const duration = ((endTime - startTime) / 1000).toFixed(1);
	return `${duration}s`;
}
