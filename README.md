# rbx-forge

> A roblox-ts and Luau CLI tool for fully-managed Rojo projects

**Rewrite in progress**
([#28](https://github.com/christopher-buss/rbx-forge/issues/28)). This branch
holds the new major version: supervised sessions, native process ownership,
config hooks, and agent-friendly `--json` output. It is not usable yet. The last
release of the old design is `1.0.0-beta.10`.

## Development

Tools are pinned in `mise.toml`: `mise install`, then `pnpm install`.

| Script                        | What it runs                                      |
| ----------------------------- | ------------------------------------------------- |
| `pnpm build`                  | tsdown bundle of the CLI into `dist/`             |
| `pnpm typecheck`              | `tsc --build` with TypeScript 7                   |
| `pnpm lint` / `pnpm lint:fix` | oxlint, then ESLint (`isentinel-lint`)            |
| `pnpm knip`                   | unused files, exports, and dependencies           |
| `pnpm test:unit`              | unit project with 100% coverage                   |
| `pnpm test:integration`       | real processes with fixture binaries              |
| `pnpm test:e2e`               | the built CLI as a subprocess (run `build` first) |
| `pnpm build:native`           | the Rust crate in `reaper/` through napi-rs       |
| `pnpm mutation`               | Stryker mutation testing                          |

Git hooks: `mise run install-hk`.

## License

[MIT](./LICENSE)
