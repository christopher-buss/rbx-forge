import type { PartId } from "./status.ts";

/** How a summary names each part. */
const PART_NAMES: Readonly<Record<PartId, string>> = {
	compiler: "the compiler",
	rojo: "Rojo",
	studio: "Studio",
};

/**
 * Name parts in a list, such as `Studio, Rojo, and the compiler`.
 *
 * @param parts - The parts, in order.
 * @returns Their names, joined for a sentence.
 */
export function listParts(parts: ReadonlyArray<PartId>): string {
	const names = parts.map((part) => PART_NAMES[part]);
	const last = names.pop();
	if (names.length === 0) {
		return String(last);
	}

	return `${names.join(", ")}${names.length > 1 ? "," : ""} and ${last}`;
}
