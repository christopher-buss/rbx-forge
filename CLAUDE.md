# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## Project Overview

**rbx-forge** is a CLI tool for fully-managed Rojo projects, designed for Roblox
TypeScript development. It wraps and manages Rojo (the Roblox project management
tool) with a simplified, opinionated workflow.

- **Package Manager**: pnpm (v10.18.1+)
- **Node Version**: >=22.16.0
- **Build Tool**: tsdown (for bundling and DTS generation)
- **CLI Framework**: Commander.js

## Development Commands

Use `@antfu/ni` package manager aliases (nr, nci) or pnpm directly:

```bash
# Install dependencies
pnpm install  # or: nci

# Build the project
pnpm build    # or: nr build

# Development watch mode
pnpm watch    # or: nr watch

# Type checking
pnpm typecheck  # or: nr typecheck

# Linting
pnpm lint       # or: nr lint
pnpm lint:ci    # or: nr lint:ci (for CI, uses content-based cache)

# Stub build (fast for development)
pnpm stub       # or: nr stub
```

**Git Hooks**: Pre-commit hook runs `lint-staged` (auto-fixes with eslint_d).

## Architecture

### Command System

Commands are located in [src/commands/](src/commands/) and follow a consistent
pattern:

1. Each command exports: `COMMAND` (string), `DESCRIPTION` (string), `action`
   (async function)
2. Commands are auto-registered in [src/index.ts](src/index.ts)
3. To add a new command: create a file in `src/commands/`, export the required
   constants, and add to the `commands` array in [src/index.ts](src/index.ts)

**Existing Commands**:

- `init`: Initialize a new rbx-forge project (creates config, runs `rojo init`)
- `build`: Build the Rojo project to an output file
- `compile`: Compile TypeScript to Luau (rbxts projects only)
- `serve`: Start the Rojo development server
- `watch`: Watch and rebuild on file changes (runs TypeScript compiler + Rojo
  server)
- `start`: Full workflow - compile, build, open Studio, and optionally run
  syncback
- `stop`: Stop running Roblox Studio processes
- `open`: Open place file in Roblox Studio (can auto-start watch mode)
- `syncback`: Sync changes from place file back to source (requires UpliftGames
  Rojo fork)
- `typegen`: Generate TypeScript types for Roblox services from Rojo sourcemap

### Config System

Located in [src/config/](src/config/), uses a multi-layer approach:

- **Loader** ([loader.ts](src/config/loader.ts)): Uses `c12` to load
  configuration files (supports `.ts`, `.js`, `.json`, `.yaml`, `.toml`, and
  more)
- **Schema** ([schema.ts](src/config/schema.ts)): Runtime validation with
  `arktype`
- **Defaults** ([defaults.ts](src/config/defaults.ts)): Default configuration
  values
- **Creator** ([create.ts](src/config/create.ts)): Generates/updates config
  files

**Current Config Options**:

- `buildOutputPath`: Output path for Rojo builds (default: `"game.rbxl"`)
- `commandNames`: Custom names for task runner scripts (see Command Chaining
  below)
- `projectType`: Project type (`"rbxts"` or `"luau"`)

The `defineConfig()` helper provides type safety for user configs.

**IMPORTANT: When adding or modifying config options:**

1. Update [schema.ts](src/config/schema.ts) with the new option
2. Update [defaults.ts](src/config/defaults.ts) with the default value
3. **MUST update [docs/configuration.md](docs/configuration.md)** with full
   documentation:
    - Add the option to the "Available Options" section
    - Include Type and Default
    - Provide description and examples
    - Update any examples if needed

### Command Chaining and Hook Pattern

rbx-forge follows the rbxts-build pattern for command chaining, enabling users
to hook into commands through task runner scripts. This provides a flexible
extension mechanism without requiring explicit hook infrastructure.

**Architecture**:

1. **CLI commands** always use base names: `rbx-forge build`, `rbx-forge serve`
2. **Script names** are customizable via `commandNames` config (default:
   `forge:` prefix)
3. **Generated scripts** call base CLI commands
4. **Command chaining** (when implemented) uses `runScript()` utility to respect
   calling context

**Default Configuration**:

```typescript
// rbx-forge.config.ts (default values)
export default defineConfig({
	commandNames: {
		build: "forge:build",
		init: "init",
		serve: "forge:serve",
	},
});
```

**Generated Scripts (after `rbx-forge init`)**:

```json
// package.json
{
	"scripts": {
		"forge:build": "rbx-forge build",
		"forge:serve": "rbx-forge serve"
	}
}
```

```toml
# .mise.toml
[tasks."forge:build"]
description = "Build the Rojo project"
run = [ "rbx-forge build" ]

[tasks."forge:serve"]
description = "Start the Rojo development server"
run = [ "rbx-forge serve" ]
```

**User Customization Examples**:

Users can intercept and extend commands by modifying generated scripts:

```json
// Pre/post hooks
{
	"scripts": {
		"forge:build": "echo 'Building...' && rbx-forge build && echo 'Done!'",
		"forge:serve": "rbx-forge build && rbx-forge serve"
	}
}
```

```toml
# Mise with environment setup
[tasks."forge:serve"]
run = [
  "npm install",
  "rbx-forge build",
  "rbx-forge serve"
]
```

**Implementation Details**:

- **Context Detection**
  ([detect-task-runner.ts](src/utils/detect-task-runner.ts)):
    - `getCallingTaskRunner()`: Detects if invoked via npm/mise using
      environment variables (`npm_lifecycle_event`, `MISE_TASK_NAME`)
    - `detectAvailableTaskRunner()`: Checks for project-level mise tasks
      (`mise tasks ls --local`) or npm scripts in package.json
- **Script Execution** ([run-script.ts](src/utils/run-script.ts)):
    - `runScript(scriptName, config)`: Executes scripts via appropriate task
      runner
    - Priority: calling context > auto-detect (mise > npm) > direct CLI
    - Ensures command chains stay within same task runner
- **Name Resolution** ([command-names.ts](src/utils/command-names.ts)):
    - `getCommandName(baseName, config)`: Resolves script names from config
    - Used during script generation (init command)

**Adding Command Chaining to New Commands**:

When implementing commands that need to call other commands:

```typescript
import { loadProjectConfig } from "../config";
import { runScript } from "../utils/run-script";

export async function action(): Promise<void> {
	const config = await loadProjectConfig();

	// Chain to another command
	await runScript("build", config); // Uses npm/mise based on context
	await runScript("serve", config); // User hooks will be executed
}
```

This ensures:

- Same task runner used throughout chain (npm → npm, mise → mise)
- User customizations in scripts are respected
- Hooks execute in correct order
- Consistent behavior regardless of invocation method

**Note**: Customizing `commandNames` lets you organize your scripts with
prefixes (like `forge:build`) while keeping the CLI simple (`rbx-forge build`).
This provides flexibility for your workflow without changing the core commands.

### Run Utility

[src/utils/run.ts](src/utils/run.ts) is a wrapper around `execa` that provides:

- **`run(command, args, options)`**: Execute commands with pretty output using
  `@clack/prompts`
    - Spinner support (spinnerMessage, successMessage)
    - Output streaming control (shouldStreamOutput)
    - Command display control (shouldShowCommand)
- **`runOutput(command, args, options)`**: Execute and return stdout as string
  (no streaming)

Use this utility for all external command execution to maintain consistent UX.

### WSL Detection

[src/utils/is-wsl.ts](src/utils/is-wsl.ts) detects Windows Subsystem for Linux.
This is critical for Rojo execution:

- WSL: use `"rojo"` command
- Windows: use `"rojo.exe"` command

See [src/commands/build.ts](src/commands/build.ts) for usage example.

### Process Management

[src/utils/process-manager.ts](src/utils/process-manager.ts) provides
centralized process lifecycle management:

**Purpose**: Track child processes and ensure they're properly terminated during
application shutdown.

**Usage**:

When spawning long-running processes that should be cleaned up on exit:

```typescript
import { processManager, setupSignalHandlers } from "../utils/process-manager";
import { runScript } from "../utils/run";

export async function action(): Promise<void> {
	setupSignalHandlers(); // Setup global SIGINT/SIGTERM handlers

	// Spawn process with automatic tracking
	await runScript("watch", [], {
		shouldRegisterProcess: true, // ProcessManager will track this
	});
}
```

**How it works**:

1. Commands call `setupSignalHandlers()` to install global handlers
2. Long-running processes are registered with `shouldRegisterProcess: true`
3. On SIGINT/SIGTERM, ProcessManager kills all tracked processes
4. Cleanup uses `killProcessTree()` to kill entire process trees

**Studio Lockfile** (separate from ProcessManager):

The `stop` command uses a separate lockfile system to track Roblox Studio:

- Studio PID is written to a lockfile when opened
- `stop` command reads the lockfile and kills Studio
- This is independent of ProcessManager's process tracking

**Important**: Do not use ProcessManager hooks - they have been removed for
simplicity. Use execa's `cancelSignal` option for graceful cancellation instead.

## Code Quality Standards

Before marking any task as complete, **ALWAYS** run both quality checks:

1. **Type checking**: `nr typecheck` - Must pass with zero errors
2. **Linting**: `nr lint` - Must pass with zero errors and warnings

**Important**: The lint command can auto-fix many issues. If you see fixable
warnings/errors, run `nr lint` to automatically fix them before proceeding.

**Workflow**:

```bash
# After making changes
nr typecheck  # Check types
nr lint       # Fix and check linting (auto-fixes where possible)
```

Do not mark a task as complete if either check fails. Address all errors and
warnings before proceeding.

## Commit Conventions

Follow Conventional Commits format (see
[.github/commit-instructions.md](.github/commit-instructions.md)):

**Format**: `<type>(<scope>): <subject>`

**Types**: feat, fix, docs, style, refactor, perf, test, build, ci, chore,
revert **Scopes** (optional): assets, audio, core, deps, dev, lint, mtx

**Rules**:

- Use imperative mood ("add" not "added")
- No capitalization in subject (except issue references)
- No period at end
- Max 72 characters
- Use `<type>(<scope>)!` for breaking changes

**Examples**:

- `feat(core): add config validation system`
- `fix(deps): update rojo detection logic`
- `docs: update installation instructions`

## Key Dependencies

- **commander**: CLI framework for command registration
- **@clack/prompts**: Beautiful CLI prompts and spinners
- **execa**: Process execution (wrapped by run utility)
- **c12**: Config loader with multiple sources support
- **arktype**: Runtime type validation for configs
- **magicast**: AST-based config file manipulation
- **ansis**: Terminal colors (chalk alternative)

## CI/CD

GitHub Actions workflow ([.github/workflows/ci.yaml](.github/workflows/ci.yaml))
runs:

1. Build check (`nr build`)
2. Linting (`nr lint:ci`)
3. Type checking (`nr typecheck`)

All three must pass before merging.
