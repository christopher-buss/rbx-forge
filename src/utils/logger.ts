import ansis from "ansis";

const S_BAR = "|";
const S_INFO = ansis.blue("o");
const S_WARN = ansis.yellow("^");
const S_ERROR = ansis.red("#");
const S_SUCCESS = ansis.green("v");
const S_STEP = ansis.cyan(">");

function formatMessage(symbol: string, message: string): string {
	return `${ansis.gray(S_BAR)}\n${symbol}  ${message}`;
}

export const logger = {
	error(message: string): void {
		console.error(formatMessage(S_ERROR, ansis.red(message)));
	},

	info(message: string): void {
		console.log(formatMessage(S_INFO, message));
	},

	message(message: string): void {
		console.log(`${ansis.gray(S_BAR)}  ${message}`);
	},

	step(message: string): void {
		console.log(formatMessage(S_STEP, message));
	},

	success(message: string): void {
		console.log(formatMessage(S_SUCCESS, ansis.green(message)));
	},

	warn(message: string): void {
		console.warn(formatMessage(S_WARN, ansis.yellow(message)));
	},
};
