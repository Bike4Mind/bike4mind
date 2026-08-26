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
grep -rhE "^(import|export).*from ['\"]@bike4mind/" packages/cli/dist
```

`tsdown.config.ts` declares ten entries (`src/index.tsx` plus nine `src/commands/*`),
and `bin/bike4mind-cli.mjs` dynamically imports each emitted file by path. A
surviving external in `dist/commands/mcpCommand.mjs` - which is what dispatches
`mcp serve`, the very thing being registered - or in any shared chunk would pass a
check that only read `dist/index.mjs`, while still 404-ing at install.

Anchoring to line-initial `import`/`export` matters as much as scanning the whole
directory: the bundles carry JSDoc that *mentions* `@bike4mind/*` in prose and code
examples, so a bare `from '@bike4mind/...'` substring search reports matches in
comments. A pre-publish check that cries wolf is a check people learn to skip.

A non-empty result means the published binary will fail at install or startup.

> The build guard (`packages/cli/src/verifyBundleExternals.ts`) does NOT catch this
> today: it asserts every external import is a *declared* dependency, and a package
> in `dependencies` satisfies that while still being unpublished. Tightening it to
> reject any surviving `@bike4mind/*` external is worth doing, but it changes four
> existing tests that encode the old assumption, so it belongs in its own change.

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
`packages/cli/package.json`. **Before merging it**, bump `mcp-registry/server.json`
to the same version (`version` and `packages[0].version`) - `mcpRegistryEntry.test.ts`
fails the build if they disagree, which is what stops the registry entry pointing at
a version that never shipped.

Merging the Version Packages PR publishes to npm via OIDC.

### 2. Prove the published package installs - the gate

```bash
npx -y @bike4mind/cli@latest --version
```

Run this in a clean directory, against the **public** registry. If it fails, stop:
every release from 0.10.2 through 0.20.1 would have passed a source-tree check and
failed here. Do not publish a registry entry pointing at a package nobody can
install.

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
  version. Never set it ahead: changesets decides the next number at release time,
  so a guess breaks the moment a `minor` changeset lands first.
- Both pairings are enforced by `packages/cli/src/mcpRegistryEntry.test.ts` - they
  are test failures, not conventions.
- `description` in `server.json` is capped at **100 characters** by the registry.
