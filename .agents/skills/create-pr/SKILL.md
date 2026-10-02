---
name: create-pr
description: Open a GitHub pull request for the current work with `gh`, branching and committing first if needed. Use when the user asks to open a PR, submit changes for review, or "PR this".
---

Open a pull request for the current work, branching, committing, and pushing
first if needed. Asking for a PR authorizes those steps — do them directly.

## 1. Get to a pushable feature branch

Resolve the default branch: `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`. Then:

- **On the default branch** → create and switch to a feature branch (`type/short-description`, kebab-case) before committing. If the local default is ahead of its remote, branch at `HEAD`, then `git reset --hard <remote-default>` so those commits live only on the feature branch.
- **Uncommitted changes** → commit, following the repo's commit conventions. Split into logical commits only when the diff spans separate concerns.
- Push with `git push -u origin HEAD`.

**Stop and ask** only when ambiguous: a tree mixing this change with unrelated edits, or histories that have diverged (force-push territory).

**Done when** HEAD is a feature branch, the tree is clean, and the branch is on the remote.

## 2. Read the diff

Read the change against the default branch:

```bash
git diff <base>...HEAD --name-status
git log <base>...HEAD --oneline
git diff <base>...HEAD
```

Capture every issue the commits reference (`#NNN`, `closes #NNN`, `fixes #NNN`).

**Done when** you can name the change type, the systems touched, and every referenced issue.

## 3. Title

```text
type(scope): imperative description
```

Conventional commit. Derive it from the diff, not the branch name. Types: `feat`, `fix`,
`refactor`, `chore`, `docs`, `test`, `perf`, `ci`, `build`, `style`. Follow the repo's
commit conventions for scopes (see `CLAUDE.md` / `AGENTS.md` and
`.github/commit-instructions.md`). Issues are GitHub issues: reference them in the
body (`Closes #NNN`), not in the title.

The title usually becomes the merge commit, so name the payoff, the effect a
reader cares about, rather than the mechanism:

BAD
> ❌ `perf(server): negotiate permessage-deflate on the websocket`

GOOD
> ✅ `perf(server): cut websocket frame size by 70%+ with gzipping`

## 4. Body

Call the Skill tool with "pr" for the body template. Write the body for a
reviewer who has not read the conversation, applying these repository rules to
its sections:

- **Evidence** — name the command or artifact and the revision it covers. Reuse
  valid results; report skipped checks and gaps honestly. When only
  after-change evidence exists, say what it demonstrates and what is missing.
- **Merge Danger** — for a one-way door, state the rollback condition, such as
  a coordinated consumer change or a migrated config. Blast radius names the
  actual affected users, commands, or workflows, including `--json` output,
  error codes, config, and processes left running.

After the `pr` sections, add the references:

```markdown
## References

Closes #NNN
Parent: #NNN
```

`Closes #NNN` for each issue the PR resolves. Link a parent PRD with
`Parent: #NNN`, or `Closes #NNN` when this is its final slice. Omit the section
when there are no references.

**Done when** every commit-referenced issue is accounted for in the body.

## 5. Labels

List the repo's labels with `gh label list`. Add any that apply to the change type or
scope; do not create new labels.

## 6. Create

```bash
gh pr create --title "<title>" --body-file <body-file> --base <base> --label "<name>"
```

Write the exact body to a temporary file first.

Base is the detected default branch. Open ready-for-review unless the changes are clearly WIP or the user asked for a draft, in which case add `--draft`. Honor any base or title the user supplied.

**Done when** `gh` returns the PR URL. Output it.
