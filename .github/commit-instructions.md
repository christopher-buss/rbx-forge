<type>(<scope>): <subject>

<body>

<footer>

## Type should be one of the following:

- feat: a new feature
- fix: a bug fix
- docs: documentation only changes
- style: changes that do not affect the meaning of the code
- refactor: a code change that neither fixes a bug nor adds a feature
- perf: a code change that improves performance
- test: adding missing tests or correcting existing tests
- build: changes that affect the build system or external dependencies
- ci: changes to our ci configuration files and scripts
- chore: other changes that don't modify src or test files
- revert: reverts a previous commit

Use "<type>(<scope>)!" for breaking changes

## Scope is optional: the area changed

- core: the session, its parts, and the commands that drive them
- dev: the development environment
- deps: dependencies
- lint: linting and formatting only
- a command (`open`, `status`, `syncback`) or a part (`studio`, `reaper`,
  `native`, `supervisor`)

## Pull request titles

A pull request merges as one squash commit, titled with the pull request title.
changelogithub writes the release notes from these titles, so a title follows
the rules below; the Lint PR workflow checks it with commitlint.

## Subject line rules:

- Use imperative mood: "change" not "changed" nor "changes"
- No dot (.) at the end
- Limit to 72 characters
- No capitilization in the subject aside from issue references

## Body rules:

- Wrap at 72 characters
- Use imperative mood
- Explain what and why vs. how Footer rules:
- Reference issues and pull requests liberally
- Use "Fixes #123" or "Closes #123" for issues
