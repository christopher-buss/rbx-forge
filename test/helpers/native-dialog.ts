import type { FakeProcess } from "./native.ts";

/**
 * Invoke only a matching dialog button on the fake process desktop.
 * @param entry - The pinned fake process.
 * @param title - The exact dialog title.
 * @param button - The exact button name.
 * @param desktop - The requested desktop.
 * @returns Whether the dialog was dismissed.
 */
export async function dismissDialogAsync(
	entry: FakeProcess,
	title: string,
	button: string,
	desktop: string,
): Promise<boolean> {
	await Promise.resolve();
	if (
		!entry.alive ||
		(entry.desktop ?? "user") !== desktop ||
		entry.dialog?.title !== title ||
		entry.dialog.button !== button
	) {
		return false;
	}

	delete entry.dialog;
	entry.blocked = false;
	return true;
}
