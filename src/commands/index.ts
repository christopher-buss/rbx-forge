import * as buildCmd from "./build";
import * as initCmd from "./init";
import * as serveCmd from "./serve";

export const COMMANDS = [buildCmd, initCmd, serveCmd] as const;

export * as buildCmd from "./build";
export * as initCmd from "./init";
export * as serveCmd from "./serve";
