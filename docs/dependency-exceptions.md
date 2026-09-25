# Dependency exceptions

Every dependency is on its latest usable version. This file lists each one that
is not, or that needs a note, with the reason. Remove an entry when it no longer
applies. Checked 2026-09-25.

| Dependency                       | Pinned                 | Latest                        | Reason                                                                                                                                                                                                                                       |
| -------------------------------- | ---------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typescript`                     | 6.0.3                  | 7.0.2                         | JS-API consumers (typescript-eslint, Stryker checker) need TS 6: typescript-eslint 8.70.1 peers `>=4.8.4 <6.1.0`. Held by `updateConfig.ignoreDependencies` and a Renovate rule.                                                             |
| `@typescript/native`             | `npm:typescript@7.0.2` | (no such package)             | No real `@typescript/native` package exists. The spec name is a pnpm alias of `typescript@7`, which provides `tsc` (TS 7) for typecheck and vitest type tests. TS 7's bin is `tsc`, not `tsgo`; pnpm links the higher version to `.bin/tsc`. |
| `@typescript/native-preview`     | (removed)              | 7.0.0-dev.20260707.2          | Superseded by the stable TS 7 alias above.                                                                                                                                                                                                   |
| `@isentinel/tsconfig`            | 2.0.0                  | 2.0.0                         | Latest, but peers `typescript@^5.5.0`; works with 6.0.3. The peer warning is expected.                                                                                                                                                       |
| `@isentinel/eslint-config`       | 6.0.0-beta.46          | 6.0.0-beta.46                 | Pre-release: the `latest` tag is a beta; no stable 6.x exists. Excluded from `minimumReleaseAge`.                                                                                                                                            |
| `oxlint-tsgolint`                | 7.0.2002               | 7.0.2003                      | 7.0.2003 was published under 24 hours ago and fails `minimumReleaseAge` (1 day). Renovate raises it.                                                                                                                                         |
| `hk` (mise)                      | 1.53.0                 | 2.2.0                         | Same as project-halcyon. hk 2.2.0 was released 2026-09-25 with breaking config changes; move after it has settled and halcyon moves.                                                                                                         |
| `pkl` (mise)                     | 0.31.1                 | 0.32.1                        | Same as project-halcyon, paired with hk 1.53.0 and the hk pkl package v1.45.0.                                                                                                                                                               |
| `node` (mise)                    | 26.5.0                 | 26.10.0                       | Same as project-halcyon's dev line. `engines.node` is `>=24.12.0`, as in halcyon's packages.                                                                                                                                                 |
| `pnpm`                           | 11.24.0                | 12.6.0 (`latest-11`: 11.27.1) | Same as project-halcyon.                                                                                                                                                                                                                     |
| `c12`                            | 4.0.0-rc.2             | 4.0.0-rc.2                    | Only a release candidate exists for 4.x; this is the newest 4.x pre-release. Keep this entry until 4.0.0 is stable.                                                                                                                          |
| `arktype`                        | 2.2.3                  | 2.2.5                         | 2.2.5 was published under 24 hours ago and fails `minimumReleaseAge` (1 day). Renovate raises it.                                                                                                                                            |
| `jiti`                           | 2.7.0 (runtime)        | 2.7.0                         | Latest. A runtime dependency: c12 loads a `rbx-forge.config.ts` through it when native import fails.                                                                                                                                         |
| `@stryker-mutator/vitest-runner` | 10.0.0 + patch         | 10.0.0                        | Latest, patched (`patches/`, same patch as project-halcyon). Without it the runner builds test-name filters with `" "` while vitest 5 names tests with `" > "`, so every mutant runs zero tests and survives.                                |

Runtime dependencies not added yet (`@clack/prompts`, `ansis`, `chokidar`,
`picomatch`, `std-env`) are left out because nothing imports them (knip fails on
unused dependencies). Each ticket adds the ones it uses, at the latest version.

Removed with the old implementation: `execa`, `commander`, `magicast`,
`package-manager-detector`, `dedent`, `@antfu/ni`, `simple-git-hooks`,
`lint-staged`, `bumpp`, `unplugin-unused`, direct `@typescript-eslint/*`
devDependencies (now pnpm overrides), and the `rbx-forge: workspace:*`
self-dependency.
