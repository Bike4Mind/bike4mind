/**
 * @vitest-environment node
 *
 * mcpHandler ships its workspace packages unbundled: copyFiles brings their dist, and `nodejs.install`
 * brings their npm dependencies. The install list is hand-written, so a copied package gaining a
 * runtime dependency leaves the Lambda failing at init with `Cannot find package '<dep>'` - nothing
 * at build or typecheck time notices, because every workspace resolves the dep from the monorepo.
 *
 * Text-matched, not executed: infra/ is an SST program and does not load outside `sst`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { arrayLiterals, balanced, copiedFrom, soleMatch, stripComments } from './helpers/infraSource';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

/** Dependencies the copied packages declare that the Lambda deliberately does not install. */
const NOT_INSTALLED: Record<string, string> = {
  '@anthropic-ai/sdk': 'type-only import in the MCP client, erased at build',
  '@bike4mind/fab-pipeline': 'imported only by the remote/ entry, which the spawned MCP server children never load',
};

function mcpHandlerLists() {
  const source = stripComments(read('infra/mcp.ts'));
  const declaration = balanced(
    source,
    soleMatch(source, /\bexport const mcpHandler\b/g, 'mcpHandler declaration').index,
    '{',
    '}'
  );
  const installList = balanced(
    declaration,
    soleMatch(declaration, /\binstall:\s*\[/g, '`install` list on mcpHandler').index,
    '[',
    ']'
  );
  const copyList = balanced(
    declaration,
    soleMatch(declaration, /\bcopyFiles:\s*\[/g, '`copyFiles` list on mcpHandler').index,
    '[',
    ']'
  );
  return { installed: arrayLiterals(installList, '`install`'), copied: copiedFrom(copyList) };
}

describe('mcpHandler installs every npm dependency of the packages it copies', () => {
  const { installed, copied } = mcpHandlerLists();
  const manifests = copied.filter(source => source.endsWith('/package.json'));

  it('finds copied package manifests to check', () => {
    expect(manifests.length, 'no copied package.json, so the check below would be vacuous').toBeGreaterThan(0);
  });

  it.each(manifests)('%s', manifest => {
    const { dependencies = {} } = JSON.parse(read(manifest)) as { dependencies?: Record<string, string> };
    const copiedWorkspacePackage = (name: string, version: string) =>
      version.startsWith('workspace:') && manifests.some(source => JSON.parse(read(source)).name === name);
    const missing = Object.entries(dependencies)
      .filter(([name]) => !installed.includes(name) && !(name in NOT_INSTALLED))
      .filter(([name, version]) => !copiedWorkspacePackage(name, version))
      .map(([name]) => name);
    expect(missing, `add to mcpHandler's nodejs.install in infra/mcp.ts`).toEqual([]);
  });
});
