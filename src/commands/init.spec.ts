import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
	createCommandContext,
	createMemoryFileSystem,
	createRecordingReporter,
	createTestSeams,
	PROJECT,
} from "../../test/helpers/seams.ts";
import type { MemoryFileSystem } from "../../test/helpers/seams.ts";
import type { FlagValues } from "../cli/flags.ts";
import type { Prompter } from "../seams/prompter.ts";
import type { CommandContext } from "./context.ts";
import { renderConfigFile, runInitAsync } from "./init.ts";

const CONFIG_PATH = path.join(PROJECT, "rbx-forge.config.ts");

interface InitProject {
	context: CommandContext;
	disk: MemoryFileSystem;
	reporter: ReturnType<typeof createRecordingReporter>;
}

function makeProject(
	files: Record<string, string> = {},
	options: { interactive?: boolean; prompter?: Prompter } = {},
): InitProject {
	const disk = createMemoryFileSystem(files);
	const reporter = createRecordingReporter();
	const seams = createTestSeams({
		fileSystem: disk.fileSystem,
		...(options.prompter === undefined ? {} : { prompter: options.prompter }),
	});
	const context = createCommandContext({
		interactive: options.interactive ?? false,
		reporter,
		seams,
	});

	return { context, disk, reporter };
}

async function initAsync(
	project: InitProject,
	flags: FlagValues = {},
): ReturnType<typeof runInitAsync> {
	return runInitAsync(project.context, { config: {}, flags });
}

function answering(answers: { choose?: string; confirm?: boolean }): Prompter {
	return {
		choose: vi.fn<Prompter["choose"]>().mockResolvedValue(answers.choose ?? ""),
		confirm: vi.fn<Prompter["confirm"]>().mockResolvedValue(answers.confirm ?? false),
	};
}

describe(runInitAsync, () => {
	it("should write a typed config file and nothing else", async () => {
		expect.assertions(1);

		const project = makeProject({ "package.json": "{}" });
		await initAsync(project, { type: "luau" });

		expect(project.disk.files()).toStrictEqual({
			"package.json": "{}",
			"rbx-forge.config.ts": renderConfigFile("luau"),
		});
	});

	it("should write a config that imports defineConfig and sets the project type", () => {
		expect.assertions(1);

		expect(renderConfigFile("rbxts")).toBe(
			[
				'import { defineConfig } from "rbx-forge";',
				"",
				"export default defineConfig({",
				'\tprojectType: "rbxts",',
				"});",
				"",
			].join("\n"),
		);
	});

	it("should report the path and project type", async () => {
		expect.assertions(1);

		await expect(initAsync(makeProject(), { type: "rbxts" })).resolves.toStrictEqual({
			data: { path: CONFIG_PATH, projectType: "rbxts", replaced: false },
			summary: "Created rbx-forge.config.ts (rbxts).",
		});
	});

	it("should reject an unknown --type as usage", async () => {
		expect.assertions(1);

		await expect(initAsync(makeProject(), { type: "python" })).rejects.toMatchObject({
			code: "usage",
			hint: 'Run "forge init --help" for usage.',
			message: '--type must be rbxts or luau, got "python".',
		});
	});

	describe("without a terminal", () => {
		it("should take rbxts as the default project type and say so", async () => {
			expect.assertions(2);

			const project = makeProject();
			const result = await initAsync(project);

			expect(result.data).toMatchObject({ projectType: "rbxts" });
			expect(project.reporter.events).toStrictEqual([
				{ message: "No --type given; using rbxts.", type: "info" },
			]);
		});

		it("should fail with needs_confirmation when a config file exists", async () => {
			expect.assertions(2);

			const project = makeProject({ "rbx-forge.config.ts": "old" });

			await expect(initAsync(project, { type: "rbxts" })).rejects.toMatchObject({
				code: "needs_confirmation",
				hint: "Pass --force to replace it.",
				message: "rbx-forge.config.ts already exists.",
			});
			expect(project.disk.files()["rbx-forge.config.ts"]).toBe("old");
		});

		it("should replace the config file with --force", async () => {
			expect.assertions(2);

			const project = makeProject({ "rbx-forge.config.ts": "old" });
			const result = await initAsync(project, { force: true, type: "luau" });

			expect(result).toStrictEqual({
				data: { path: CONFIG_PATH, projectType: "luau", replaced: true },
				summary: "Replaced rbx-forge.config.ts (luau).",
			});
			expect(project.disk.files()["rbx-forge.config.ts"]).toBe(renderConfigFile("luau"));
		});
	});

	describe("at a terminal", () => {
		it("should ask for the project type, offering rbxts first", async () => {
			expect.assertions(3);

			const prompter = answering({ choose: "luau" });
			const project = makeProject({}, { interactive: true, prompter });
			const result = await initAsync(project);

			expect(prompter.choose).toHaveBeenCalledExactlyOnceWith(
				"Project type?",
				["rbxts", "luau"],
				"rbxts",
			);
			expect(result.data).toMatchObject({ projectType: "luau" });
			expect(project.reporter.events).toBeEmpty();
		});

		it("should not ask for the project type when --type is given", async () => {
			expect.assertions(1);

			const prompter = answering({});
			await initAsync(makeProject({}, { interactive: true, prompter }), { type: "rbxts" });

			expect(prompter.choose).not.toHaveBeenCalled();
		});

		it("should replace an existing config file when the user agrees", async () => {
			expect.assertions(3);

			const prompter = answering({ confirm: true });
			const project = makeProject(
				{ "rbx-forge.config.ts": "old" },
				{ interactive: true, prompter },
			);
			const result = await initAsync(project, { type: "rbxts" });

			expect(result.data).toMatchObject({ replaced: true });

			expect(prompter.confirm).toHaveBeenCalledExactlyOnceWith(
				"rbx-forge.config.ts exists. Replace it?",
				false,
			);
			expect(project.disk.files()["rbx-forge.config.ts"]).toBe(renderConfigFile("rbxts"));
		});

		it("should keep the config file and fail as declined when the user refuses", async () => {
			expect.assertions(2);

			const prompter = answering({ confirm: false });
			const project = makeProject(
				{ "rbx-forge.config.ts": "old" },
				{ interactive: true, prompter },
			);

			await expect(initAsync(project, { type: "rbxts" })).rejects.toMatchObject({
				code: "declined",
				message: "Kept the existing rbx-forge.config.ts.",
			});
			expect(project.disk.files()["rbx-forge.config.ts"]).toBe("old");
		});
	});

	it.for(["rbx-forge.config.json", "rbx-forge.config.mjs"])(
		"should refuse to write beside %s, even with --force",
		async (other) => {
			expect.assertions(2);

			const project = makeProject({ [other]: "{}" });

			await expect(initAsync(project, { force: true, type: "rbxts" })).rejects.toMatchObject({
				code: "config_exists",
				hint: "Remove it to let forge init write rbx-forge.config.ts.",
				message: `${other} already configures this project.`,
			});
			expect(Object.keys(project.disk.files())).toHaveLength(1);
		},
	);

	it("should name every other config file it found", async () => {
		expect.assertions(1);

		const project = makeProject({ "rbx-forge.config.js": "", "rbx-forge.config.json": "{}" });

		await expect(initAsync(project, { type: "rbxts" })).rejects.toMatchObject({
			message: "rbx-forge.config.js, rbx-forge.config.json already configures this project.",
		});
	});

	it("should ignore files that only look like a config file", async () => {
		expect.assertions(1);

		const project = makeProject({ "rbx-forge.config.ts.bak": "old", "rbx-forge.configs": "x" });

		await expect(initAsync(project, { type: "rbxts" })).resolves.toMatchObject({
			data: { replaced: false },
		});
	});
});
