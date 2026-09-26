/**
 * The `rbx-forge` library entry: what a `rbx-forge.config.ts` file imports.
 */
export { defineConfig } from "./config/define-config.ts";
export type {
	AutoRecoveryMode,
	ForgeConfig,
	HookCommand,
	HookPhases,
	LuauOptions,
	LuauWatchOptions,
	OpenOptions,
	ProjectType,
	RbxtsOptions,
	SessionOptions,
	StudioOptions,
	SyncbackOptions,
	TypegenOptions,
} from "./config/schema.ts";
