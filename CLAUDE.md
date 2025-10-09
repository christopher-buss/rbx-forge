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
- `serve`: Start the Rojo development server
- `test`: Test command for the run utility (development only)

### Config System

Located in [src/config/](src/config/), uses a multi-layer approach:

- **Loader** ([loader.ts](src/config/loader.ts)): Uses `c12` to load
  `rbx-forge.config.ts`
- **Schema** ([schema.ts](src/config/schema.ts)): Runtime validation with
  `arktype`
- **Defaults** ([defaults.ts](src/config/defaults.ts)): Default configuration
  values
- **Creator** ([create.ts](src/config/create.ts)): Generates/updates config
  files

**Current Config Options**:

- `buildOutputPath`: Output path for Rojo builds (default: `"game.rbxl"`)

The `defineConfig()` helper provides type safety for user configs.

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
