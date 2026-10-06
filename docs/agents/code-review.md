# Code Review Invocation

`/code-review` is imported unedited; these inputs replace its committed-only
diff. Resolve the review base to a fixed merge-base SHA. When the scope includes
pending work, provide `git diff <baseline-sha>` plus the relevant files listed
by `git ls-files --others --exclude-standard`, and name uncommitted changes
separately from the reviewed SHA. Spawn both review sub-agents as the `reviewer`
agent.

The standards sources are `AGENTS.md` and `CONTRIBUTING.md`.
