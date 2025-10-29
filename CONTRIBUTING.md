# Contributing to rbx-forge

Thank you for your interest in contributing to rbx-forge! This document provides
guidelines and instructions for contributing.

## Development Setup

### Prerequisites

- **Node.js** >= 22.16.0
- **pnpm** >= 10.18.1
- **Git**

### Getting Started

1. **Fork and clone the repository**

```bash
git clone https://github.com/YOUR_USERNAME/rbx-forge.git
cd rbx-forge
```

2. **Install dependencies**

```bash
pnpm install
```

3. **Build the project**

```bash
pnpm build
```

### Development Workflow

#### Available Scripts

- `pnpm build` - Build the project with tsdown (bundling + DTS generation)
- `pnpm watch` - Development watch mode with auto-rebuild
- `pnpm stub` - Fast stub build for development
- `pnpm typecheck` - Run TypeScript type checking
- `pnpm lint` - Run ESLint (auto-fixes issues)
- `pnpm lint:ci` - Run ESLint for CI (content-based cache)

#### Code Quality Standards

**Before submitting any PR, you MUST ensure these pass:**

```bash
pnpm typecheck  # Must pass with zero errors
pnpm lint       # Must pass with zero errors/warnings
```

The linter can auto-fix many issues. If you see fixable warnings or errors, run
`pnpm lint` to automatically fix them.

### Git Workflow

#### Commit Conventions

We follow [Conventional Commits](https://www.conventionalcommits.org/) format.
See [.github/commit-instructions.md](.github/commit-instructions.md) for full
details.

**Format:** `<type>(<scope>): <subject>`

**Types:**

- `feat` - New feature
- `fix` - Bug fix
- `docs` - Documentation changes
- `style` - Code style changes (formatting, etc.)
- `refactor` - Code refactoring
- `perf` - Performance improvements
- `test` - Adding or updating tests
- `build` - Build system changes
- `ci` - CI/CD changes
- `chore` - Maintenance tasks
- `revert` - Reverting changes

**Scopes (optional):**

- `core` - Core functionality
- `config` - Configuration system
- `deps` - Dependencies
- `dev` - Development tooling
- `lint` - Linting related

**Rules:**

- Use imperative mood: "add" not "added"
- No capitalization in subject (except issue references)
- No period at end
- Max 72 characters
- Breaking changes: add `!` after type/scope

**Examples:**

```bash
feat(core): add restart command
fix(config): resolve type validation issue
docs: update installation instructions
refactor(commands): simplify build logic
```

#### Git Hooks

Pre-commit hooks are automatically installed via `simple-git-hooks` and will:

- Run `lint-staged` on staged files
- Auto-fix linting issues with `eslint_d`

If the hook fails, fix the issues and try committing again.

### Making Changes

1. **Create a feature branch**

```bash
git checkout -b feat/your-feature-name
# or
git checkout -b fix/your-bug-fix
```

2. **Make your changes**

Follow the existing code style and architecture patterns:

- Commands go in `src/commands/`
- Configuration logic in `src/config/`
- Utilities in `src/utils/`
- See [CLAUDE.md](CLAUDE.md) for detailed architecture overview

3. **Test your changes**

```bash
pnpm build
pnpm typecheck
pnpm lint
```

Manually test the CLI commands:

```bash
# Use the local build
node dist/index.mjs --help
node dist/index.mjs init
```

4. **Commit your changes**

```bash
git add .
git commit -m "feat(core): add new feature"
```

5. **Push and create PR**

```bash
git push origin feat/your-feature-name
```

Then create a Pull Request on GitHub.

### Pull Request Guidelines

- **Title:** Use conventional commit format
- **Description:**
    - Clearly describe what changes you made and why
    - Reference any related issues
    - Include screenshots/examples if relevant
- **Checklist:**
    - [ ] Code follows project conventions
    - [ ] `pnpm typecheck` passes
    - [ ] `pnpm lint` passes
    - [ ] Commit messages follow conventional commits
    - [ ] Documentation updated if needed

### CI/CD

GitHub Actions will automatically run on your PR:

- Build check
- Type checking
- Linting (CI mode with content-based cache)

All checks must pass before merging.

### Project Structure

```text
rbx-forge/
├── src/
│   ├── commands/      # CLI command implementations
│   ├── config/        # Configuration system
│   ├── utils/         # Utility functions
│   └── index.ts       # Main entry point
├── scripts/           # Helper scripts
├── .github/           # GitHub workflows and templates
├── examples/          # Example configurations
└── docs/              # Additional documentation
```

### Adding a New Command

1. Create a new file in `src/commands/your-command.ts`
2. Export `COMMAND`, `DESCRIPTION`, and `action` function
3. Add to the `commands` array in `src/index.ts`
4. Update documentation in README.md
5. Add to default `commandNames` in `src/config/defaults.ts`
6. Update schema in `src/config/schema.ts` if needed

See existing commands for examples.

### Getting Help

- **Issues:**
  [GitHub Issues](https://github.com/christopher-buss/rbx-forge/issues)
- **Discussions:** Use GitHub Discussions for questions
- **Architecture:** See [CLAUDE.md](CLAUDE.md) for detailed architecture docs

### Code of Conduct

Be respectful, inclusive, and constructive. We're all here to build great tools
for the Roblox development community.

## License

By contributing to rbx-forge, you agree that your contributions will be licensed
under the MIT License.
