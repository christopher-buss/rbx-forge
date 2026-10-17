import { readFileSync } from "node:fs";
import process from "node:process";

/** How often a worker looks for its grandchildren's start records. */
const POLL_MS = 10;

/**
 * Exit `FIXTURE_EXIT_AFTER_MS` after the grandchildren recorded their start,
 * when `FIXTURE_EXIT_ROLE` is unset or names this role.
 *
 * @param role - This fake worker's role.
 * @param environment - The fake worker's environment.
 */
export function exitOnItsOwn(role: string, environment: NodeJS.ProcessEnv): void {
	const exitAfter = environment["FIXTURE_EXIT_AFTER_MS"];
	const exitRole = environment["FIXTURE_EXIT_ROLE"];
	if (exitAfter === undefined || (exitRole !== undefined && exitRole !== role)) {
		return;
	}

	function exit(): void {
		process.stderr.write(`${role} exits on its own\n`);
		process.exit(
			Number(
				environment["FIXTURE_EXIT_AFTER_CODE"] ?? environment["FIXTURE_EXIT_CODE"] ?? "0",
			),
		);
	}

	afterChildrenRecorded(
		environment["FIXTURE_LOG"],
		Number(environment["FIXTURE_GRANDCHILDREN"] ?? "0"),
		() => {
			setTimeout(exit, Number(exitAfter));
		},
	);
}

/**
 * Run `then` once `count` children of this process are in the fixture log: a
 * worker that exits first lets the reaper kill them before they record.
 *
 * @param logFile - The `FIXTURE_LOG` path; without one, `then` runs at once.
 * @param count - Children to wait for.
 * @param then - What runs once they all recorded.
 */
function afterChildrenRecorded(logFile: string | undefined, count: number, then: () => void): void {
	if (count === 0 || logFile === undefined) {
		then();
		return;
	}

	const child = `"ppid":${process.pid},`;
	const timer = setInterval(() => {
		const recorded = readFileSync(logFile, "utf8")
			.split("\n")
			.filter((line) => line.includes(child)).length;
		if (recorded >= count) {
			clearInterval(timer);
			then();
		}
	}, POLL_MS);
}
