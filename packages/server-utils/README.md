# @bike4mind/server-utils

Server code shared by `apps/client` and `apps/workers`, moving out of `apps/client/server` one slice at a time. Private, never published.

## Source-only contract

`exports` maps `./*` to `./src/*.ts` and there is no build step, so every consumer loads raw TypeScript. Each consumer runtime must opt in, and a new one (another app, a container, another package's tests) needs its own equivalent of all three:

1. **A transpile hook.** The Next pages router needs `transpilePackages` (`apps/client/next.config.mjs`). Otherwise it externalizes the package and Node `require()`s raw `.ts`. esbuild Lambdas and vitest transpile it already.
2. **A tsx tsconfig include.** tsx applies `strict` and `target` only to files its tsconfig includes, so each tsx entrypoint's tsconfig must include `packages/server-utils/src/**/*.ts`: `apps/client/tsconfig.json` (Dockerfile.chatcompletion) and `apps/workers/tsconfig.selfhost.json` (self-host worker and agentexecutor).
3. **A turbo `inputs` glob.** `^build` never hashes a package with no build, so the consumer's typecheck/test tasks must list `../../packages/server-utils/**` (minus its `node_modules`) in `inputs` (`turbo.json`, the `@bike4mind/client#*` and `@bike4mind/workers#*` entries). Without it, an edit here replays a cached green result for that consumer.

The package must never import from either app, their path aliases (`@server/*`, `@client/*`, `@/*`, ...) or UI code. `eslint.config.mjs` enforces this.

## Moving files in

1. `git mv` each file (and its colocated test) to its package path, and commit. `apps/client/server/<tail>` goes to `src/<tail>`; `apps/client/{lib,shared,config,services,app/utils}/<tail>` keeps its client-relative path (`apps/client/lib/x.ts` goes to `src/lib/x.ts`). No other client directory can move.
2. Run `pnpm tsx scripts/codemods/move-to-server-utils.ts <old paths...>` to rewrite every importer to the package path, and commit that separately so the move stays a pure rename.
3. Add any new import the moved files need to this `package.json`; do not rely on hoisting. A workspace package that now imports a moved file needs this package as a dependency and the `inputs` glob above.
4. Grep the premium overlays for the old paths. For each hit, leave a re-export shim at the old path (`export * from '@bike4mind/server-utils/<tail>';`, plus `export { default }` if the file has one) until the overlay imports the package. The codemod accepts a shim at an old path, so it can be re-run after a rebase.

## Tests

```bash
pnpm --filter @bike4mind/server-utils test              # unit suites
pnpm --filter @bike4mind/server-utils test:integration  # real-Mongo *.e2e.test.ts suites
```

A suite that boots a real mongod must be named `*.e2e.test.ts` (`src/mongoTestTimeoutBudget.test.ts` enforces it). CI runs the unit lane in the `misc` test shard and the integration lane in the shared `workers-server-utils-integration` leg.
