import { type } from "arktype";

import type { Clock } from "./clock.ts";
import type { PinnedStudio } from "./studio-host.ts";
import { pinnedIdentity, unsupportedAsync } from "./wsl-helper-results.ts";

type Request = <T>(
	operation: Record<string, unknown>,
	shape: { assert: (value: unknown) => T },
	timeoutMs?: number,
) => Promise<T>;

/**
 * Build the process-local helper adapter for one verified Windows Studio.
 * @param value - The helper's pinned process identity.
 * @param request - Validated requests on this process's helper channel.
 * @param clock - The exit polling clock.
 * @param startHidingAsync - Starts the independent window watcher.
 * @returns Studio operations on the verified pin.
 */
// eslint-disable-next-line flawless/max-lines-per-function -- Flat mapping of the Studio pin interface.
export function createWslStudioPin(
	value: unknown,
	request: Request,
	clock: Clock,
	startHidingAsync: (identity: ReturnType<typeof pinnedIdentity>) => Promise<boolean>,
): PinnedStudio {
	const identity = pinnedIdentity(value);
	async function boolAsync(op: string): Promise<boolean> {
		return request({ op, pin: identity.pin }, type("boolean"));
	}

	return {
		activateAppAsync: unsupportedAsync,
		appActiveAsync: unsupportedAsync,
		appHiddenAsync: unsupportedAsync,
		desktopAsync: async () => {
			return request({ op: "desktop", pin: identity.pin }, type("'hidden' | 'user'"));
		},
		dismissDialogAsync: async (title, button, desktop, timeoutMs = 1000) => {
			return request(
				{ button, desktop, op: "dismissDialog", pin: identity.pin, timeoutMs, title },
				type("boolean"),
				timeoutMs,
			);
		},
		executablePathAsync: async () => {
			return request({ op: "executablePath", pin: identity.pin }, type("string | null"));
		},
		isAliveAsync: async () => boolAsync("isAlive"),
		isBlockedAsync: async () => boolAsync("isBlocked"),
		killAsync: async () => boolAsync("kill"),
		os: "win32",
		pid: identity.pid,
		requestCloseAsync: async () => boolAsync("requestClose"),
		requestSaveAsync: async (timeoutMs = 30_000) => {
			return request(
				{ op: "requestSave", pin: identity.pin, timeoutMs },
				type("'menu_disabled' | 'no_menu_item' | 'requested' | 'timeout'"),
				timeoutMs,
			);
		},
		saveMenuEnabledAsync: async (timeoutMs) => {
			return request(
				{ op: "saveMenuEnabled", pin: identity.pin, timeoutMs },
				type("boolean"),
				timeoutMs,
			);
		},
		setAppHiddenAsync: unsupportedAsync,
		setWindowVisibilityAsync: async (visibility) => {
			return request(
				{ op: "setWindowVisibility", pin: identity.pin, visibility },
				type("boolean"),
			);
		},
		startTime: identity.startTime,
		startWindowHidingAsync: async () => startHidingAsync(identity),
		stopWindowHidingAsync: async () => boolAsync("stopWindowHiding"),
		waitForExitAsync: async (timeoutMs) => {
			const deadline = clock.now() + timeoutMs;
			while (
				await request(
					{ op: "isAlive", pin: identity.pin },
					type("boolean"),
					Math.max(1, deadline - clock.now()),
				)
			) {
				if (clock.now() >= deadline) {
					return false;
				}

				await clock.sleep(Math.min(50, deadline - clock.now()));
			}

			return true;
		},
		windowHidingAsync: async () => boolAsync("windowHiding"),
		windowVisibilityAsync: async () => {
			return request(
				{ op: "windowVisibility", pin: identity.pin },
				type("'hidden' | 'user' | null"),
			);
		},
	};
}
