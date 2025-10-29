# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] - 2025-01-XX

### Added

#### Commands
- `init` - Initialize a new rbx-forge project with config and task runner scripts
- `build` - Build the Rojo project to an output file
- `compile` - Compile TypeScript to Luau (roblox-ts projects only)
- `serve` - Start the Rojo development server
- `watch` - Watch and rebuild on file changes
- `start` - Full workflow: compile, build, open Studio, optional syncback
- `stop` - Stop running Roblox Studio processes
- `open` - Open place file in Roblox Studio
- `restart` - Restart the current workflow
- `syncback` - Sync changes from place file back to source
- `typegen` - Generate TypeScript types from Rojo sourcemap

#### Configuration System
- TypeScript-based configuration with `rbx-forge.config.ts`
- Runtime validation with arktype schema
- Support for both roblox-ts and pure Luau projects
- Customizable command names for task runner integration
- Configurable build paths, compiler options, and type generation

#### Task Runner Integration
- Automatic npm script generation in `package.json`
- Automatic mise task generation in `.mise.toml`
- Command chaining that respects calling context
- Hook system through task runner script customization

#### Developer Experience
- WSL (Windows Subsystem for Linux) detection and support
- Pretty CLI output with @clack/prompts
- Process lifecycle management with automatic cleanup
- Comprehensive error handling and user feedback

#### Project Infrastructure
- MIT License with dual copyright (osyrisrblx/rbxts-build + Christopher Buss)
- CI/CD with GitHub Actions (build, lint, typecheck)
- Pre-commit hooks with lint-staged
- Conventional Commits enforcement

### Notes

This is the initial release of rbx-forge, a fork and evolution of [rbxts-build](https://github.com/roblox-ts/rbxts-build) by osyrisrblx. The project has been rewritten with modern tooling and enhanced functionality while maintaining the core philosophy of opinionated, fully-managed Rojo workflows.

<!-- [0.1.0]: https://github.com/christopher-buss/rbx-forge/releases/tag/v0.1.0 -->
