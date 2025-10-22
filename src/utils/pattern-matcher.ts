import picomatch from "picomatch";

export interface FilterOptions {
	exclude: ReadonlyArray<string>;
	include: ReadonlyArray<string>;
	maxDepth: number | undefined;
}

/**
 * Creates a path filter function based on include/exclude patterns and max
 * depth.
 *
 * @param options - Filter configuration.
 * @returns Function that returns true if a path should be included.
 */
export function createPathFilter(options: FilterOptions): (path: string, depth: number) => boolean {
	const includeMatcher = picomatch([...options.include]);
	const excludeMatcher = picomatch([...options.exclude]);

	return (path: string, depth: number): boolean => {
		if (options.maxDepth !== undefined && depth > options.maxDepth) {
			return false;
		}

		if (excludeMatcher(path)) {
			return false;
		}

		return includeMatcher(path);
	};
}
