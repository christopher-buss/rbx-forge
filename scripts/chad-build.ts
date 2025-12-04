#!/usr/bin/env bun
/* eslint-disable max-lines -- build script */

import type { BuildOutput } from "bun";
import chokidar from "chokidar";
import { access, rename, rm } from "node:fs/promises";
import path from "node:path";
import process, { exit } from "node:process";

type BuildResult = Awaited<ReturnType<typeof Bun.build>>;

const args = new Set(Bun.argv.slice(2));
const flags = {
	clean: args.has("--clean"),
	dts: args.has("--dts"),
	watch: args.has("--watch"),
};

const PROJECT_ROOT = path.resolve(new URL("..", import.meta.url).pathname);
process.chdir(PROJECT_ROOT);

const DIST_DIRECTORY = path.join(PROJECT_ROOT, "dist");
const TYPES_OUT_DIR = path.join(DIST_DIRECTORY, ".types");
const ENTRY = path.join(PROJECT_ROOT, "src/index.ts");
const TSCONFIG_PATH = path.join(PROJECT_ROOT, "tsconfig.json");
const JS_OUTPUT = path.join(DIST_DIRECTORY, "index.js");
const MODULE_OUTPUT = path.join(DIST_DIRECTORY, "index.mjs");

if (flags.clean) {
	await rm(DIST_DIRECTORY, { force: true, recursive: true });
}

const buildConfig: Bun.BuildConfig = {
	entrypoints: [ENTRY],
	format: "esm",
	naming: { entry: "[name].js" },
	outdir: DIST_DIRECTORY,
	packages: "bundle",
	root: PROJECT_ROOT,
	splitting: false,
	target: "bun",
	throw: false,
};

if (flags.watch) {
	await watchBuildsAsync();
} else {
	const success = await runOnceAsync(false);
	if (!success) {
		exit(1);
	}
}

interface InlineImportInfo {
	fullMatch: string;
	modulePath: string;
	typeName: string;
}

// eslint-disable-next-line max-lines-per-function, sonar/cognitive-complexity -- don't care
async function bundleDtsAsync(
	relativePath: string,
	visited: Set<string>,
	output: Array<string>,
	imports: Set<string>,
): Promise<void> {
	const normalized = relativePath.replace(/\\/g, "/");
	if (visited.has(normalized)) {
		return;
	}

	const importRegExp = /^(?:import|export).*from\s+["'](\.\/|\.\.\/)[^"']+["']/;
	visited.add(normalized);

	const fullPath = path.join(TYPES_OUT_DIR, normalized);
	let raw = await Bun.file(fullPath).text();

	if (raw.startsWith("#!")) {
		raw = raw.slice(raw.indexOf("\n") + 1);
	}

	const lines = raw.split("\n");
	const directoryName = path.posix.dirname(normalized);
	const deps = new Set<string>();

	const body: Array<string> = [];

	for (const line of lines) {
		const trimmed = line.trim();
		const relativeMatch = importRegExp.exec(trimmed);

		if (relativeMatch?.[1] !== undefined) {
			const specifier = line.slice(line.indexOf(relativeMatch[1]));
			const pathMatch = /(\.\/|\.\.\/)[^"']+/.exec(specifier);
			if (pathMatch !== null) {
				const basePath = relativeSpecifierToDts(pathMatch[0], directoryName);
				let resolved = basePath;

				if (!(await pathExists(path.join(TYPES_OUT_DIR, resolved)))) {
					const withIndex = path.posix.join(basePath.slice(0, -5), "index.d.ts");
					// eslint-disable-next-line max-depth -- don't care
					if (await pathExists(path.join(TYPES_OUT_DIR, withIndex))) {
						resolved = withIndex;
					} else {
						continue;
					}
				}

				deps.add(resolved);
			}

			continue;
		}

		const externalMatch = /^(?:import|export).*from\s+["'](?!\.\/|\.\.\/)[^"']+["']/.exec(
			trimmed,
		);
		if (externalMatch !== null) {
			imports.add(line);
			continue;
		}

		if (trimmed === "export {};") {
			continue;
		}

		body.push(line);
	}

	for (const dep of deps) {
		await bundleDtsAsync(dep, visited, output, imports);
	}

	output.push(...body, "");
}

async function emitTypes(): Promise<boolean> {
	const typeResult =
		await Bun.$`bun x tsgo --emitDeclarationOnly --declaration --module ESNext --moduleResolution bundler --noEmit false --outDir ${TYPES_OUT_DIR} --rootDir ${PROJECT_ROOT} --project ${TSCONFIG_PATH}`.nothrow();

	if (typeResult.exitCode !== 0) {
		console.error("✘ [ERROR] Declaration emit failed.");
		return false;
	}

	return true;
}

async function ensureDeclarationExtension(): Promise<void> {
	const indexDefinitionModule = path.join(DIST_DIRECTORY, "index.d.mts");
	const entryRelative = "src/index.d.ts";
	const entryPath = path.join(TYPES_OUT_DIR, entryRelative);

	if (!(await pathExists(entryPath))) {
		console.warn("⚠ [WARN] No declaration entrypoint was found; skipping .d.mts creation.");
		return;
	}

	const visited = new Set<string>();
	const bundledImports = new Set<string>();
	const bundledParts: Array<string> = ["#!/usr/bin/env node", ""];

	await bundleDtsAsync(entryRelative, visited, bundledParts, bundledImports);

	// Join the bundled content for transformation
	const rawContent = bundledParts.slice(2).join("\n");

	// Transform inline imports to namespace imports
	const { content: transformedContent, namespaceImports } = transformInlineImports(rawContent);

	const output: Array<string> = ["#!/usr/bin/env node", ""];

	// Add namespace imports first (for inline import transformations)
	if (namespaceImports.length > 0) {
		output.push(...namespaceImports, "");
	}

	// Add external imports from bundled files
	if (bundledImports.size > 0) {
		output.push(...bundledImports, "");
	}

	// Add transformed content
	output.push(transformedContent);

	await rm(indexDefinitionModule, { force: true });
	await Bun.write(indexDefinitionModule, output.join("\n"));
	await rm(TYPES_OUT_DIR, { force: true, recursive: true });
}

async function ensureShebang(outputPath: string): Promise<void> {
	const entryFile = Bun.file(outputPath);

	if (!(await entryFile.exists())) {
		console.warn(`⚠ [WARN] Expected bundle at ${outputPath}`);
		return;
	}

	const contents = await entryFile.text();
	if (contents.startsWith("#!")) {
		return;
	}

	await Bun.write(outputPath, `#!/usr/bin/env node\n${contents}`);
}

function extractInlineImports(content: string): Array<InlineImportInfo> {
	const results: Array<InlineImportInfo> = [];
	// Matches: import("some/path").TypeName or import("some/path").TypeName<...>
	const inlineImportRegex = /import\(["']([^"']+)["']\)\.(\w+)/g;

	for (const match of content.matchAll(inlineImportRegex)) {
		if (match[1] !== undefined && match[2] !== undefined) {
			results.push({
				fullMatch: match[0],
				modulePath: match[1],
				typeName: match[2],
			});
		}
	}

	return results;
}

function handleBuildOutput(result: BuildOutput): boolean {
	if (!result.success) {
		reportLogs(result.logs, "error");
		return false;
	}

	if (result.logs.length > 0) {
		reportLogs(result.logs, "warn");
	}

	return true;
}

async function handleDefinitionsAsync(): Promise<boolean> {
	if (flags.dts) {
		const isTypesOkay = await emitTypes();
		if (!isTypesOkay) {
			return false;
		}

		await ensureDeclarationExtension();
	}

	return true;
}

function onWatchFail(error: unknown): void {
	console.error("✘ [ERROR] Watch pipeline failed");
	console.error(error);
}

async function pathExists(target: string): Promise<boolean> {
	try {
		await access(target);
		return true;
	} catch {
		return false;
	}
}

function relativeSpecifierToDts(specifier: string, from: string): string {
	const withExtension = specifier.endsWith(".d.ts") ? specifier : `${specifier}.d.ts`;
	return path.posix.normalize(path.posix.join(from, withExtension));
}

async function renameJsToMjs(): Promise<void> {
	const hasJs = await pathExists(JS_OUTPUT);
	const hasMjs = await pathExists(MODULE_OUTPUT);

	if (hasJs) {
		await rm(MODULE_OUTPUT, { force: true });
		await rename(JS_OUTPUT, MODULE_OUTPUT);
		return;
	}

	if (!hasMjs) {
		console.warn("⚠ [WARN] No bundle output was produced.");
	}
}

function reportLogs(logs: BuildOutput["logs"], logLevel: "error" | "warn"): void {
	const withoutThem = logs.filter(({ level }) => {
		return (
			(logLevel !== "error" || level === "error") &&
			(logLevel !== "warn" || level !== "error")
		);
	});

	for (const { level, message, position } of withoutThem) {
		const prefix = level === "error" ? "✘ [ERROR]" : "⚠ [WARN]";
		const write = level === "error" ? console.error : console.warn;

		write(`${prefix} ${message}`);

		if (position?.file !== undefined && position.file.length > 0) {
			const location =
				position.line && position.column
					? `${position.file}:${position.line}:${position.column}`
					: position.file;
			write(`    ${location}`);
		}
	}
}

function resolveModulePath(rawPath: string): string {
	// tsgo emits paths like "node_modules/whatever/out/variants/object"
	// tsdown keeps these paths as-is and they resolve correctly
	return rawPath;
}

async function runOnceAsync(isRebuild: boolean, reason?: string): Promise<boolean> {
	if (isRebuild && reason !== undefined) {
		console.info(`↻ Rebuilding (${reason})`);
	}

	let result: BuildResult;
	try {
		result = await Bun.build(buildConfig);
	} catch (err) {
		console.error("✘ [ERROR] Bun.build threw unexpectedly");
		console.error(err);
		return false;
	}

	if (!handleBuildOutput(result)) {
		return false;
	}

	await renameJsToMjs();
	await ensureShebang(MODULE_OUTPUT);

	const isTypesOkay = await handleDefinitionsAsync();
	if (!isTypesOkay) {
		return false;
	}

	const isPublintOk = await runPublintAsync();
	if (!isPublintOk) {
		return false;
	}

	console.info("🙏 Build succeeded!");
	return true;
}

async function runPublintAsync(): Promise<boolean> {
	const publintResult = await Bun.$`bun x publint`.nothrow();

	if (publintResult.exitCode !== 0) {
		console.error("✘ [ERROR] publint reported issues.");
		return false;
	}

	return true;
}

// eslint-disable-next-line max-lines-per-function -- tightly coupled logic
function transformInlineImports(content: string): {
	content: string;
	namespaceImports: Array<string>;
} {
	const inlineImports = extractInlineImports(content);
	if (inlineImports.length === 0) {
		return { content, namespaceImports: [] };
	}

	const moduleToNamespace = new Map<string, string>();
	const namespaceImports: Array<string> = [];
	let namespaceCounter = 0;

	for (const { modulePath } of inlineImports) {
		if (!moduleToNamespace.has(modulePath)) {
			const resolvedPath = resolveModulePath(modulePath);
			const safeName = resolvedPath
				.replaceAll(/[^a-zA-Z0-9]/g, "_")
				.replaceAll(/_+/g, "_")
				.replace(/^_/, "")
				.replace(/_$/, "");

			const namespace = `${safeName}${namespaceCounter}`;
			namespaceCounter += 1;
			moduleToNamespace.set(modulePath, namespace);
			namespaceImports.push(`import * as ${namespace} from "${resolvedPath}";`);
		}
	}

	let transformed = content;
	for (const { fullMatch, modulePath, typeName } of inlineImports) {
		const namespace = moduleToNamespace.get(modulePath);
		if (namespace !== undefined) {
			transformed = transformed.replaceAll(fullMatch, `${namespace}.${typeName}`);
		}
	}

	return { content: transformed, namespaceImports };
}

const CONFIGURATION = {
	ignored: ["**/dist/**", "**/node_modules/**"],
	ignoreInitial: true,
};

function noOperation(): void {
	// does nothing
}

async function watchBuildsAsync(): Promise<never> {
	let chain: Promise<void> = Promise.resolve();

	const initialSuccessPromise = runOnceAsync(false);

	const watcher = chokidar.watch(
		[
			path.join(PROJECT_ROOT, "src"),
			path.join(PROJECT_ROOT, "tsconfig.json"),
			path.join(PROJECT_ROOT, "package.json"),
		],
		CONFIGURATION,
	);

	function enqueue(reason: string): void {
		chain = chain
			.then(async () => runOnceAsync(true, reason))
			.then(noOperation)
			.catch(onWatchFail);
	}

	watcher.on("all", (event, changedPath) => {
		enqueue(`${event} ${path.relative(PROJECT_ROOT, changedPath)}`);
	});

	void initialSuccessPromise.then((initialSuccess) => {
		if (!initialSuccess) {
			console.warn("⚠ [WARN] Initial build failed; watching for changes...");
		} else {
			console.info("👀 Watching for changes...");
		}
	});

	return new Promise<never>(noOperation);
}
