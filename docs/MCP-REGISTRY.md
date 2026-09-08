# Publishing the Bike4Mind MCP server to the MCP Registry

The MCP server is `b4m mcp serve` (`packages/cli/src/mcp/`), shipped inside the
`@bike4mind/cli` npm package. The registry hosts **metadata only**: the entry in
`mcp-registry/server.json` points at the npm package, and clients install that.

Namespace is `io.github.bike4mind/*`, authorized by GitHub auth as a member of the
Bike4Mind org - no DNS record or keypair needed, unlike the sibling remote-server
listings.

## Why the package must be installable first

The registry validates ownership by fetching the published package and checking its
`mcpName`. Clients then `npx` it. So an uninstallable package cannot be listed, and
would be useless if it were.

Every release from **0.10.2 (2026-06-04) through 0.20.1** was uninstallable:
`npm i -g @bike4mind/cli` 404'd, first on `@bike4mind/fab-pipeline` and later on
`@bike4mind/hearth`. Cause: `@bike4mind/*` packages are meant to be bundled inline
(`deps.neverBundle` in `tsdown.config.ts` excludes the scope), but declaring one in
`dependencies` makes the bundler externalize it anyway - and none of them are
published to public npm. The last installable version was 0.10.1.

**The invariant:** no `@bike4mind/*` package may appear in the CLI's runtime
`dependencies`. Keeping them in `devDependencies` is what makes them bundle.

Verify before every publish:

```bash
pnpm turbo:core:build && pnpm --filter @bike4mind/cli build
# must print nothing - scans every emitted bundle, and only real imports:
grep -rnE "^[[:space:]]*(import|export)[^*]*from ['\"]@bike4mind/" packages/cli/dist packages/cli/bin
```

`tsdown.config.ts` declares ten entries (`src/index.tsx` plus nine `src/commands/*`),
and `bin/bike4mind-cli.mjs` dynamically imports each emitted file by path. A
surviving external in `dist/commands/mcpCommand.mjs` - which is what dispatches
`mcp serve`, the very thing being registered - or in any shared chunk would pass a
check that only read `dist/index.mjs`, while still 404-ing at install.

Excluding comments matters as much as scanning the whole directory. The bundles
carry JSDoc that *mentions* `@bike4mind/*` in code examples, so a bare
`from '@bike4mind/...'` search reports matches in prose - measured against a real
build, one line in `AgentHistoryStore-*.mjs`. A pre-publish check that cries wolf is
a check people learn to skip.

The pattern excludes comments via `[^*]*` and leading-whitespace tolerance rather
than by anchoring hard to column zero, because a hard `^` anchor silently stops
working the moment output is indented or minified - `tsdown.config.ts` sets no
`minify` today, so that would be one flag flip away from a permanent green. `-n`
names the offending bundle, which is what you need first when it does fire.

A non-empty result means the published binary will fail at install or startup.

> The build guard (`packages/cli/src/verifyBundleExternals.ts`) does NOT catch this
> today. `isExternalPackage` returns `false` for anything under `@bike4mind/`
> (`BUNDLED_SCOPES`, line 63) *before* the declared-dependency comparison runs, so
> the scope never reaches that check at all - declaredness is the secondary reason,
> not the operative one. Tightening this therefore means changing the filter, not
> just the declared-deps rule; it also changes four existing tests that encode the
> old assumption, so it belongs in its own change.

## Publish

**Do not run `npm publish` by hand.** It cannot work: `@bike4mind/cli` is published
by `.github/workflows/release.yaml` using changesets plus npm **Trusted Publishing
(OIDC)**. npm allows exactly one trusted publisher per package and validates the
top-level workflow file, so every publish must enter through `release.yaml` - there
is no token fallback. A laptop `npm publish` is outside that path, and would fail on
version alone anyway, since the current `package.json` version is already `latest`
on npm (E403, "cannot publish over the previously published versions").

### 1. Ship the package through the release pipeline

```bash
pnpm changeset            # describe the change; patch is right for a dep move
git commit -am "chore: changeset for cli publish"
```

Merge that. `release.yaml` opens a **"Version Packages"** PR which bumps
`packages/cli/package.json`. The registry entry follows automatically:
`scripts/sync-mcp-registry-version.mjs` is chained into `changeset:version`, so that
PR arrives with `server.json` already in step and nothing to hand-edit.
`mcpRegistryEntry.test.ts` guards the generator - if the sync ever silently no-ops,
that test goes red on the Version Packages PR.

Merging the Version Packages PR publishes to npm via OIDC.

### 2. Prove the published package installs - the gate

```bash
cd "$(mktemp -d)" && export HOME="$PWD/home" && mkdir -p "$HOME"
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"gate","version":"0"}}}' \
  | B4M_API_URL=https://app.bike4mind.com npx -y @bike4mind/cli@latest mcp serve \
  | head -1
```

Expect a `result` frame naming the server, and the process to stay up:

```json
{"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":true},
"resources":{"listChanged":true}},"serverInfo":{"name":"bike4mind","version":"<current>"}},
"jsonrpc":"2.0","id":1}
```

Run it in a clean directory with a fresh `HOME`, against the **public** registry -
that is what a client sandbox looks like after `npx`, with no stored config or OAuth
token to fall back on. Dropping `B4M_API_URL` is the counter-check: it must exit 1
with `No API endpoint configured` rather than hang or serve.

Run `mcp serve` and not `--version`. `--version` never resolves an endpoint, so it
prints happily on a build that cannot serve at all: it would have passed on 0.20.1,
whose `mcp serve` exits at startup with `No API endpoint configured`. The gate has to
be the thing the consumer actually runs, reaching the stdio handshake.

If it fails, stop. Every release from 0.10.2 through 0.20.1 would have passed a
source-tree check and failed here. Do not publish a registry entry pointing at a
package nobody can install.

### 3. Publish the registry entry

```bash
brew install mcp-publisher
cd mcp-registry
mcp-publisher login github        # any Bike4Mind org member
mcp-publisher publish
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.bike4mind/bike4mind"
```

## Keeping it in step

- `mcpName` in `packages/cli/package.json` MUST equal `name` in
  `mcp-registry/server.json`, or the registry rejects the publish.
- `server.json`'s `version` and `packages[0].version` MUST equal the package's
  version. No human owns this: `scripts/sync-mcp-registry-version.mjs` runs inside
  `changeset:version` and rewrites both from `packages/cli/package.json`. Never set
  it ahead by hand - changesets decides the next number at release time, so a guess
  breaks the moment a `minor` changeset lands first.
- Both pairings are enforced by `packages/cli/src/mcpRegistryEntry.test.ts` - they
  are test failures, not conventions.
- `description` in `server.json` is capped at **100 characters** by the registry.
- `B4M_API_URL` is declared `isRequired: true` because there is no baked default:
  `release.yaml` injects `vars.B4M_DEFAULT_API_URL` into the bundle at build time and
  that variable is unset, so `getDefaultApiUrl()` compiles to `return ""`. Setting it
  as a repo variable would make `npx` turnkey and let the entry go back to
  `isRequired: false` - re-verify the built bundle before changing the entry.
