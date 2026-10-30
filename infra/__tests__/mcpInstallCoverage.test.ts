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
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { arrayLiterals, balanced, copiedFrom, soleMatch, stripComments } from './helpers/infraSource';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

interface ImportSite {
  file: string;
  typeOnly: boolean;
}

/**
 * Dependencies the copied packages declare that the Lambda deliberately does not install. `holds`
 * re-checks each rationale against every import of the dep, so it cannot drift silently.
 */
const NOT_INSTALLED: Record<string, { why: string; holds: (site: ImportSite) => boolean }> = {
  '@anthropic-ai/sdk': {
    why: 'type-only import in the MCP client, erased at build',
    holds: site => site.typeOnly,
  },
  '@bike4mind/fab-pipeline': {
    why: 'imported only by the remote/ entry, which the spawned MCP server children never load',
    holds: site => site.file.startsWith('b4m-core/mcp/src/remote/'),
  },
};

type Manifest = { name: string; dependencies?: Record<string, string>; peerDependencies?: Record<string, string> };

/** What tsdown leaves external, and so what has to exist in node_modules at runtime. */
const runtimeDependencies = (manifest: Manifest) => ({ ...manifest.dependencies, ...manifest.peerDependencies });

const IMPORT =
  /\b(?:import|export)\s+(type\s+)?(?:[^'";]*?\bfrom\s+)?['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
const TEST_FILE = /(\.test\.tsx?$|\/__tests?__\/)/;

/** Bare-specifier imports in the shipped source of a copied package (tests excluded). */
function importSites(manifest: string, dep: string): ImportSite[] {
  const srcDir = path.join(path.dirname(manifest), 'src');
  const files = readdirSync(path.join(REPO_ROOT, srcDir), { recursive: true, encoding: 'utf8' })
    .map(file => path.posix.join(srcDir, file.split(path.sep).join('/')))
    .filter(file => /\.tsx?$/.test(file) && !TEST_FILE.test(file));
  return files.flatMap(file =>
    [...stripComments(read(file)).matchAll(IMPORT)]
      .map(match => ({ file, typeOnly: Boolean(match[1]), specifier: match[2] ?? match[3] }))
      .filter(({ specifier }) => specifier === dep || specifier.startsWith(`${dep}/`))
      .map(({ file, typeOnly }) => ({ file, typeOnly }))
  );
}

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

  const parsed = manifests.map(source => JSON.parse(read(source)) as Manifest);

  it.each(manifests)('%s', manifest => {
    const dependencies = runtimeDependencies(JSON.parse(read(manifest)) as Manifest);
    const copiedWorkspacePackage = (name: string, version: string) =>
      version.startsWith('workspace:') && parsed.some(copiedManifest => copiedManifest.name === name);
    const missing = Object.entries(dependencies)
      .filter(([name]) => !installed.includes(name) && !(name in NOT_INSTALLED))
      .filter(([name, version]) => !copiedWorkspacePackage(name, version))
      .map(([name]) => name);
    expect(missing, `add to mcpHandler's nodejs.install in infra/mcp.ts`).toEqual([]);
  });

  it.each(Object.entries(NOT_INSTALLED))('leaves %s out only while its rationale holds', (dep, { why, holds }) => {
    const declaredBy = manifests.filter((_, i) => dep in runtimeDependencies(parsed[i]));
    expect(declaredBy, `${dep} is no longer a copied package's dependency; drop it from NOT_INSTALLED`).not.toEqual([]);
    const violations = declaredBy.flatMap(manifest => importSites(manifest, dep)).filter(site => !holds(site));
    expect(violations, `${dep} is not installed because it is ${why}; install it or restore that`).toEqual([]);
  });
});
