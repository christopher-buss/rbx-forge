import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "vitest";

import { createFakeNative } from "../../test/helpers/native.ts";
import { createTestSeams } from "../../test/helpers/seams.ts";
import { createFakeStudioHost } from "../../test/helpers/studio-host.ts";
import { createAddonStudioHost } from "./studio-host.ts";

describe(createAddonStudioHost, () => {
	it("should keep a Studio pin on its original identity after PID reuse", async ({ expect }) => {
		expect.assertions(3);

		const original = { alive: true, executablePath: "/Studio", startTime: "100" };
		const fake = createFakeNative({ 42: original });
		const seams = createTestSeams({ native: () => fake.addon });
		const host = createAddonStudioHost(seams);
		const pinned = await host.pinProcessAsync(42, "100");

		expect(pinned).not.toBeNull();

		fake.processes.set(42, { alive: true, executablePath: "/other", startTime: "200" });

		await expect(pinned!.killAsync()).resolves.toBeTrue();
		await expect(host.pinProcessAsync(42, "100")).resolves.toBeNull();
	});

	it("should use the configured test host for Studio folders and identity", async ({
		expect,
	}) => {
		expect.assertions(2);

		const defaults = createTestSeams();
		const seams = createTestSeams({
			host: { ...defaults.host, hostname: "mac", platform: "darwin" },
		});

		await expect(seams.studioHost.hostnameAsync()).resolves.toBe("mac");
		await expect(seams.studioHost.platformAsync()).resolves.toBe("darwin");
	});

	it("should expose native Studio discovery, launch, folders, and native paths", async ({
		expect,
	}) => {
		expect.assertions(10);

		const seams = createTestSeams();
		seams.fileSystem.writeFileSync("/Studio", "executable");
		const host = createAddonStudioHost({
			...seams,
			studioLauncher: async () => {
				return {
					studio: { pid: 42, startTime: "100" },
					type: "launched",
				};
			},
		});

		await expect(
			host.findStudioExecutableAsync({ env: {}, studioPath: "/Studio" }),
		).resolves.toStrictEqual({ path: "/Studio", source: "flag" });
		await expect(host.findStudioExecutableAsync({ env: {} })).resolves.toBeUndefined();
		await expect(
			host.findStudioExecutableAsync({ env: {}, studioPath: "/missing" }),
		).rejects.toMatchObject({ code: "studio_launch_failed" });
		await expect(
			host.launchAsync({ cwd: "/", env: {}, place: "/place.rbxl" }),
		).resolves.toMatchObject({ studio: { pid: 42 }, type: "launched" });
		await expect(host.toHostPathAsync("/place.rbxl")).resolves.toBe("/place.rbxl");
		await expect(host.fromHostPathAsync("/place.rbxl")).resolves.toBe("/place.rbxl");
		await expect(host.pluginsFolderAsync({})).resolves.toBeUndefined();
		await expect(host.autoSaveDirectoriesAsync({})).resolves.toStrictEqual([]);

		const mac = createAddonStudioHost({
			...seams,
			host: { ...seams.host, platform: "darwin" },
		});

		await expect(mac.pluginsFolderAsync({ HOME: "/Users/me" })).resolves.toBe(
			path.join("/Users/me", "Documents", "Roblox", "Plugins"),
		);
		await expect(mac.autoSaveDirectoriesAsync({ HOME: "/Users/me" })).resolves.toStrictEqual([
			"/Users/me/Library/Application Support/Roblox/RobloxStudio/AutoSaves",
			"/Users/me/Documents/ROBLOX/AutoSaves",
		]);
	});

	it("should hold and release a singleton lock without changing the local lock API", async ({
		expect,
	}) => {
		expect.assertions(4);

		const fake = createFakeStudioHost(createTestSeams());
		const lock = await fake.studioHost.tryLockFileAsync("session.lock");
		assert(lock !== null);

		await expect(fake.studioHost.tryLockFileAsync("session.lock")).resolves.toBeNull();
		expect(fake.addon.isLockFree("session.lock")).toBeFalse();

		await lock.releaseAsync();
		await lock.releaseAsync();

		expect(fake.addon.isLockFree("session.lock")).toBeTrue();
		await expect(fake.studioHost.tryLockFileAsync("session.lock")).resolves.not.toBeNull();
	});

	it("should control a pinned Studio and observe its exit asynchronously", async ({ expect }) => {
		expect.assertions(24);

		const fake = createFakeStudioHost(createTestSeams(), {
			42: {
				alive: true,
				dialog: { button: "OK", title: "Lighting" },
				executablePath: "/Studio",
				startTime: "100",
				windowVisibility: "user",
			},
		});
		const host = fake.studioHost;

		await expect(host.processStartTimeAsync(42)).resolves.toBe("100");
		await expect(host.pinProcessAsync(99)).resolves.toBeNull();

		const pin = await host.pinProcessAsync(42);
		assert(pin !== null);

		expect([pin.pid, pin.startTime]).toStrictEqual([42, "100"]);
		await expect(pin.executablePathAsync()).resolves.toBe("/Studio");
		await expect(pin.isAliveAsync()).resolves.toBeTrue();
		await expect(pin.desktopAsync()).resolves.toBe("user");
		await expect(pin.isBlockedAsync()).resolves.toBeFalse();
		await expect(pin.dismissDialogAsync("Lighting", "OK", "user", 50)).resolves.toBeTrue();
		await expect(pin.activateAppAsync()).resolves.toBeTrue();
		await expect(pin.appActiveAsync()).resolves.toBeTrue();
		await expect(pin.setAppHiddenAsync(true)).resolves.toBeTrue();
		await expect(pin.appHiddenAsync()).resolves.toBeTrue();
		await expect(pin.setWindowVisibilityAsync("hidden")).resolves.toBeTrue();
		await expect(pin.windowVisibilityAsync()).resolves.toBe("hidden");
		await expect(pin.startWindowHidingAsync()).resolves.toBeTrue();
		await expect(pin.windowHidingAsync()).resolves.toBeTrue();
		await expect(pin.stopWindowHidingAsync()).resolves.toBeTrue();
		await expect(pin.windowHidingAsync()).resolves.toBeFalse();
		await expect(pin.saveMenuEnabledAsync(50)).resolves.toBeTrue();
		await expect(pin.requestSaveAsync(0)).resolves.toBe("timeout");
		await expect(pin.requestSaveAsync()).resolves.toBe("requested");
		await expect(pin.requestCloseAsync()).resolves.toBeTrue();
		await expect(pin.waitForExitAsync(50)).resolves.toBeTrue();
		await expect(host.processStartTimeAsync(42)).resolves.toBeNull();
	});

	it("should reject async operations when the native addon cannot be loaded", async ({
		expect,
	}) => {
		expect.assertions(1);
		await expect(createAddonStudioHost(createTestSeams()).pinProcessAsync(42)).rejects.toThrow(
			"native addon",
		);
	});

	it("should report the frontmost app for restoring focus after a Studio save", async ({
		expect,
	}) => {
		expect.assertions(1);

		const fake = createFakeStudioHost(createTestSeams(), {
			42: { alive: true, appActive: true, executablePath: "/Studio" },
		});

		await expect(fake.studioHost.frontmostApplicationAsync()).resolves.toBe(42);
	});
});
