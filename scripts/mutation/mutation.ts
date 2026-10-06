import path from "node:path";
import process from "node:process";

/** How Stryker ended: its exit code, or `null` when a signal killed it. */
export interface StrykerExit {
	readonly code: null | number;
}

export type Outcome = "complete" | "failed" | "partial";

export interface MutationFiles {
	readonly copy: (from: string, to: string) => void;
	readonly mkdir: (directory: string) => void;
	/** The file's contents, or `undefined` when it does not exist. */
	readonly read: (file: string) => string | undefined;
	readonly rename: (from: string, to: string) => void;
	readonly write: (file: string, contents: string) => void;
}

export interface MutationDependencies {
	readonly files: MutationFiles;
	/** The `incrementalFile` of `stryker.config.ts`. */
	readonly localFile: string;
	run: () => StrykerExit;
	/** The report every worktree of the clone shares. */
	readonly sharedFile: string;
}

export interface Report {
	readonly complete?: unknown;
	readonly files: Record<string, { readonly mutants: ReadonlyArray<unknown> }>;
}

/**
 * Stryker exits 1 when the score breaks the threshold, which is still a full
 * report; 128 + n means signal n interrupted it.
 * @param exit - How Stryker ended.
 * @returns Whether its report covers the whole run.
 */
export function classifyExit({ code }: StrykerExit): Outcome {
	if (code === 0 || code === 1) {
		return "complete";
	}

	return code === null || code > 128 ? "partial" : "failed";
}

export function countMutants(report: Pick<Report, "files">): number {
	return Object.values(report.files).reduce((total, file) => total + file.mutants.length, 0);
}

/**
 * A partial run replaces only a smaller partial report; a missing or
 * malformed shared report counts as absent.
 * @param outcome - How the local run ended.
 * @param local - The report the run wrote.
 * @param shared - The shared report, if any.
 * @returns Whether to replace the shared report with the local one.
 */
export function shouldPublish(
	outcome: Outcome,
	local: Report,
	shared: string | undefined,
): boolean {
	if (outcome === "failed") {
		return false;
	}

	const sharedReport = parseReport(shared);
	if (outcome === "complete" || sharedReport === undefined) {
		return true;
	}

	return sharedReport.complete !== true && countMutants(sharedReport) < countMutants(local);
}

/**
 * Seed the local report from the shared one, run Stryker, then publish.
 * @param dependencies - Files, paths, and the Stryker run.
 * @returns Stryker's exit code.
 */
export function runMutation(dependencies: MutationDependencies): number {
	const { files, localFile, sharedFile } = dependencies;
	const seed = files.read(sharedFile);
	if (seed !== undefined) {
		files.mkdir(path.dirname(localFile));
		files.copy(sharedFile, localFile);
	}

	const exit = dependencies.run();
	const outcome = classifyExit(exit);
	const report = parseReport(files.read(localFile));
	if (report !== undefined && shouldPublish(outcome, report, files.read(sharedFile))) {
		const temporary = `${sharedFile}.${process.pid}.tmp`;
		files.mkdir(path.dirname(sharedFile));
		files.write(temporary, JSON.stringify({ ...report, complete: outcome === "complete" }));
		files.rename(temporary, sharedFile);
	}

	return exit.code ?? 1;
}

function isReport(value: unknown): value is Report {
	if (typeof value !== "object" || value === null || !("files" in value)) {
		return false;
	}

	const { files } = value;
	return (
		typeof files === "object" &&
		files !== null &&
		Object.values(files).every((file: unknown) => {
			return (
				typeof file === "object" &&
				file !== null &&
				"mutants" in file &&
				Array.isArray(file.mutants)
			);
		})
	);
}

function parseReport(contents: string | undefined): Report | undefined {
	try {
		const report: unknown = JSON.parse(contents ?? "");
		return isReport(report) ? report : undefined;
	} catch {
		return undefined;
	}
}
