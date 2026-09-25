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

Prefer a project template if one exists — `.github/PULL_REQUEST_TEMPLATE.md`, `.github/pull_request_template.md`, or a file under `.github/PULL_REQUEST_TEMPLATE/`. Fill it from the diff. Otherwise build the body from these sections:

```markdown
## Summary

[2–5 specific sentences: what changed and why.]

## References

Closes #NNN
Parent: #NNN
```

- **Summary** — open with the problem in the user's own framing, then the
  solution in a line. Concrete, not generic:

  BAD
  > ❌ Removed implicit workspace carry-over from every "new thread" entry
  > point (cmd+n, sidebar buttons, command palette). Deleted
  > `buildContextualThreadOptions` and the v1 sidebar's seed-context machinery.

  GOOD
  > ✅ My "new worktree" default was ignored when starting new threads on
  > existing worktrees. Super unintuitive. Now your preferences always apply.

  Keep the implementation inventory out of the opening.
- **Manual verification** — add this section *only* for checks CI can't run. Omit it when there is nothing manual to report. Never restate automated test, coverage, or lint results — CI owns those.
- **References** — `Closes #NNN` for each issue the PR resolves. Link a parent PRD with `Parent: #NNN`, or `Closes #NNN` when this is its final slice.

**Done when** every commit-referenced issue is accounted for in the body.

## 5. Labels

List the repo's labels with `gh label list`. Add any that apply to the change type or
scope; do not create new labels.

## 6. Create

```bash
gh pr create --title "<title>" --body "<body>" --base <base> --label "<name>"
```

Base is the detected default branch. Open ready-for-review unless the changes are clearly WIP or the user asked for a draft, in which case add `--draft`. Honor any base or title the user supplied.

**Done when** `gh` returns the PR URL. Output it.
