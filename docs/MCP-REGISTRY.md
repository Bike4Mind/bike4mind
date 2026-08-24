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
# must print nothing:
grep -rhoE "from ['\"]@bike4mind/[a-z-]+['\"]" packages/cli/dist/index.mjs
```

A non-empty result means the published binary will fail at install or startup.

> The build guard (`packages/cli/src/verifyBundleExternals.ts`) does NOT catch this
> today: it asserts every external import is a *declared* dependency, and a package
> in `dependencies` satisfies that while still being unpublished. Tightening it to
> reject any surviving `@bike4mind/*` external is worth doing, but it changes four
> existing tests that encode the old assumption, so it belongs in its own change.

## Publish

```bash
# 1. Publish the package (npm credentials required)
pnpm --filter @bike4mind/cli build
cd packages/cli && npm publish --access public

# 2. Install-test from the public registry, in a clean directory
npx -y @bike4mind/cli@latest --version

# 3. Publish the registry entry
brew install mcp-publisher
cd mcp-registry
mcp-publisher login github        # any Bike4Mind org member
mcp-publisher publish

# 4. Verify
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.bike4mind/bike4mind"
```

Step 2 is the gate. If `npx` fails, stop - the registry entry would point at a
package nobody can install.

## Keeping it in step

- `mcpName` in `packages/cli/package.json` MUST equal `name` in
  `mcp-registry/server.json`, or the registry rejects the publish.
- Bump `version` in **both** the package and `server.json` (including the nested
  `packages[0].version`) on each release.
- `description` in `server.json` is capped at **100 characters** by the registry.
