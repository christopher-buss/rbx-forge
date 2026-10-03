import { describe, expect, it, onTestFinished, vi } from "vitest";

import { createMemoryFileSystem } from "../../test/helpers/seams.ts";
import { createNodeFileSystem } from "./file-system.ts";

describe("canonical directory watches", () => {
	it("should watch the expanded directory through its injected backend", () => {
		expect.assertions(2);

		const memory = createMemoryFileSystem();
		const realpath = vi.fn<(directory: string) => string>(
			() => "C:/Users/Christopher/AppData/Local/Temp/project",
		);
		const fileSystem = createNodeFileSystem({
			fileSystem: memory.fileSystem,
			realpath,
			watch: memory.watch.watch,
		});
		const watcher = fileSystem.watch("C:/Users/CHRIST~1/AppData/Local/Temp/project");
		onTestFinished(() => {
			watcher.close();
		});

		expect(memory.watch.activeDirectories()[0]).toMatch(/Christopher.*project$/u);

		expect(realpath).toHaveBeenCalledWith("C:/Users/CHRIST~1/AppData/Local/Temp/project");
	});
});
