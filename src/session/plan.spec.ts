import { describe, expect, it } from "vitest";

import { resolveConfig } from "../config/resolve.ts";
import type { ConfigLayer, ProjectType } from "../config/schema.ts";
import { COMPILER_MISSING_HINT, planSession } from "./plan.ts";
import type { SessionFlags } from "./plan.ts";

const ALL: SessionFlags = { compiler: true, open: true };

function plan(projectType: ProjectType, flags: SessionFlags = ALL, layer: ConfigLayer = {}) {
	return planSession(resolveConfig({ projectType }, layer), flags);
}

const RBXTSC = {
	call: {
		args: ["-w"],
		command: "rbxtsc",
		label: "The compiler",
		missing: "compiler_missing",
		missingHint: COMPILER_MISSING_HINT,
	},
	parsesDiagnostics: true,
};

describe(planSession, () => {
	it("should compile, build, open, and watch with rbxtsc -w for a roblox-ts project", () => {
		expect.assertions(1);

		expect(plan("rbxts")).toStrictEqual({
			build: true,
			compile: true,
			compiler: RBXTSC,
			open: true,
			syncback: false,
		});
	});

	it("should add the watch flag after the configured compiler arguments", () => {
		expect.assertions(1);

		const { compiler } = plan("rbxts", ALL, { rbxts: { args: ["--verbose"], command: "tsc" } });

		expect(compiler).toMatchObject({ call: { args: ["--verbose", "-w"], command: "tsc" } });
	});

	it("should run only Rojo with --no-open --no-compiler", () => {
		expect.assertions(1);

		expect(plan("rbxts", { compiler: false, open: false })).toStrictEqual({
			build: false,
			compile: false,
			compiler: undefined,
			open: false,
			syncback: false,
		});
	});

	it("should run the compiler without Studio with --no-open", () => {
		expect.assertions(1);

		expect(plan("rbxts", { compiler: true, open: false })).toMatchObject({
			build: true,
			compile: true,
			open: false,
		});
	});

	it("should run syncback on save when syncback.runOnStart is set", () => {
		expect.assertions(1);

		expect(plan("luau", ALL, { syncback: { runOnStart: true } }).syncback).toBeTrue();
	});

	it("should run the Luau watch command, without a compile step or diagnostics", () => {
		expect.assertions(1);

		const layer = { luau: { watch: { args: ["watch"], command: "darklua" } } };

		expect(plan("luau", ALL, layer)).toStrictEqual({
			build: true,
			compile: false,
			compiler: {
				call: {
					args: ["watch"],
					command: "darklua",
					label: "The Luau watch command",
					missing: "compiler_missing",
					missingHint: "Install it, or fix luau.watch.command in the config.",
				},
				parsesDiagnostics: false,
			},
			open: true,
			syncback: false,
		});
	});

	it("should run no compiler and build nothing for a Luau project with no watch command", () => {
		expect.assertions(1);

		expect(plan("luau")).toMatchObject({ build: false, compile: false, compiler: undefined });
	});
});
