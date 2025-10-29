# rbx-forge

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![CI][ci-src]][ci-href] [![bundle][bundle-src]][bundle-href]
[![JSDocs][jsdocs-src]][jsdocs-href] [![License][license-src]][license-href]

> A roblox-ts and Luau project workflow tool for fully-managed Rojo projects

rbx-forge gives you simple commands (`init`, `watch`, `build`, `open`) that
handle the full workflow: TypeScript compilation → Rojo builds → Studio
integration -> sync changes back to the filesystem. No script boilerplate
needed.

## Requirements

- **Node.js** >= 22.16.0
- **Rojo** - Install from [rojo.space](https://rojo.space) or optionally via
  [uplift-games/rojo](https://github.com/UpliftGames/rojo/releases/)
- **Task Runner** (optional) - npm, pnpm, or mise for script generation

## Installation

The recommended way to use rbx-forge is with `npx`, which automatically installs
it to your project:

```bash
npx rbx-forge init
```

This runs you through a setup wizard that installs rbx-forge to your project,
creates `rbx-forge.config.ts`, and generates task runner scripts.

### Alternative: Global Installation

If you prefer to install globally:

```bash
pnpm add -g rbx-forge
```

Then run `rbx-forge init` in your project.

## Quick Start

```bash
# Install and set up
npx rbx-forge init

# Start development server
rbx-forge start  # Builds your place file and opens Studio

# When you're done
rbx-forge stop
```

## Commands

| Command    | Description                                                   |
| ---------- | ------------------------------------------------------------- |
| `init`     | Initialize a new rbx-forge project                            |
| `build`    | Build the Rojo project to an output file                      |
| `compile`  | Compile TypeScript to Luau (roblox-ts projects only)          |
| `serve`    | Start the Rojo development server                             |
| `watch`    | Watch and rebuild on file changes                             |
| `start`    | Full workflow: compile, build, open Studio, optional syncback |
| `stop`     | Stop running Roblox Studio processes                          |
| `open`     | Open place file in Roblox Studio                              |
| `restart`  | Restart the current workflow                                  |
| `syncback` | Sync changes from place file back to source                   |
| `typegen`  | Generate TypeScript types from Rojo sourcemap                 |

## Configuration

rbx-forge uses `rbx-forge.config.ts` (recommended), `rbx-forge.config.json`, or
package.json for configuration. The `init` command creates a TypeScript config
for you with full type safety.

### Basic config

```typescript
import { defineConfig } from "rbx-forge";

export default defineConfig({
	// Where Rojo builds to
	buildOutputPath: "game.rbxl",

	// Customize generated script names (optional)
	commandNames: {
		build: "forge:build",
		serve: "forge:serve",
	},

	// "rbxts" or "luau"
	projectType: "rbxts",
});
```

### Advanced options

You can also configure:

- roblox-ts compiler settings (`rbxts.args`, `rbxts.command`)
- Syncback behavior (`syncback.runOnStart`, `syncbackInputPath`)
- Type generation (`typegen.include`, `typegen.exclude`, `typegen.maxDepth`)

See [docs/configuration.md](docs/configuration.md) for all options.

## Script Generation

`rbx-forge init` creates scripts in your task runner:

**package.json:**

```json
{
	"scripts": {
		"forge:build": "rbx-forge build",
		"forge:serve": "rbx-forge serve"
	}
}
```

**mise (.mise.toml):**

```toml
[tasks."forge:build"]
run = [ "rbx-forge build" ]
```

Customize these however you want - add pre/post hooks, chain commands, etc.:

```json
{
	"scripts": {
		"forge:build": "echo 'Building...' && rbx-forge build",
		"forge:serve": "rbx-forge build && rbx-forge serve",
		"preforge:serve": "echo 'Preparing to serve...'"
	}
}
```

rbx-forge respects your runner context when chaining commands, so your hooks
will execute.

Or skip scripts entirely and use the CLI: `rbx-forge build`

## License

[MIT](LICENSE) - Copyright for portions of rbx-forge are held by osyrisrblx
2021, as part of rbxts-build. All other copyright for rbx-forge are held by
Christopher Buss, 2025.

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for
guidelines.

## Acknowledgments

- **osyrisrblx** - Original author of
  [rbxts-build](https://github.com/roblox-ts/rbxts-build)

<!-- Badges -->

[npm-version-src]:
	https://img.shields.io/npm/v/rbx-forge?style=flat&colorA=080f12&colorB=1fa669
[npm-version-href]: https://npmjs.com/package/rbx-forge
[npm-downloads-src]:
	https://img.shields.io/npm/dm/rbx-forge?style=flat&colorA=080f12&colorB=1fa669
[npm-downloads-href]: https://npmjs.com/package/rbx-forge
[ci-src]:
	https://img.shields.io/github/actions/workflow/status/christopher-buss/rbx-forge/ci.yaml?style=flat&colorA=080f12&colorB=1fa669
[ci-href]:
	https://github.com/christopher-buss/rbx-forge/actions/workflows/ci.yaml
[bundle-src]:
	https://img.shields.io/bundlephobia/minzip/rbx-forge?style=flat&colorA=080f12&colorB=1fa669&label=minzip
[bundle-href]: https://bundlephobia.com/result?p=rbx-forge
[license-src]:
	https://img.shields.io/github/license/christopher-buss/rbx-forge.svg?style=flat&colorA=080f12&colorB=1fa669
[license-href]: https://github.com/christopher-buss/rbx-forge/blob/main/LICENSE
[jsdocs-src]:
	https://img.shields.io/badge/jsdocs-reference-080f12?style=flat&colorA=080f12&colorB=1fa669
[jsdocs-href]: https://www.jsdocs.io/package/rbx-forge
