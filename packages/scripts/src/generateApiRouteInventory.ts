/**
 * Writes docs/api-route-inventory.md from the route files on disk. Analysis lives in
 * apiRouteInventory.ts; this file only gathers sources and writes the result.
 *
 *   pnpm --filter @bike4mind/scripts api-routes:inventory
 *   pnpm --filter @bike4mind/scripts api-routes:inventory --include-overlays --out /tmp/routes.md
 *
 * Overlay routes (b4mContributions.apiRouteStubs of the packages/premium/* checkouts) are opt-in and
 * can never be written to the committed doc: this repo is public and the overlays are not.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import {
  analyzeRouteSource,
  buildScopeTable,
  contractIndexFromOpenApi,
  extractApiPaths,
  formatCallerPath,
  isCatchAllRoute,
  isTestFile,
  matchCallerPath,
  reexportedDefault,
  renderInventoryMarkdown,
  routeFromFile,
  routeMatchers,
  type ContractIndex,
  type RouteAnalysis,
  type RouteRecord,
  type ScopeTable,
  type UnresolvedCall,
} from './apiRouteInventory';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const API_DIR = 'apps/client/pages/api';
const CALLER_DIR = 'apps/client/app';
const OPENAPI_DOCUMENT = 'apps/client/public/openapi.json';
const DEFAULT_OUTPUT = 'docs/api-route-inventory.md';
const SCOPE_SOURCE_DIRS = ['b4m-core/common/src', 'apps/client/server'];
const SCOPE_SOURCE_PATTERN = /(UserApiKeyTypes|Scopes)\.ts$/;
const SOURCE_PATTERN = /\.(ts|tsx)$/;

/**
 * Files whose `/api/...` strings are not calls to this app: a hand-written API reference (it would
 * mark every documented route as called) and a Jupyter server client (its `/api/sessions` is Jupyter's).
 */
const NON_CALLER_FILES = new Set([
  'apps/client/app/components/admin/content/apiReferenceContent.ts',
  'apps/client/app/utils/jupyterBrowserClient.ts',
]);

const overlayManifestSchema = z.object({
  name: z.string(),
  b4mContributions: z.object({ apiRouteStubs: z.array(z.object({ generatedPath: z.string() })).optional() }).optional(),
});

/** Repo-relative source files under `dir`, skipping tests and the gitignored premium-* codegen. */
function sourceFiles(dir: string): string[] {
  const absolute = path.join(ROOT, dir);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { recursive: true, encoding: 'utf8' })
    .map(entry => path.posix.join(dir, entry.split(path.sep).join('/')))
    .filter(file => SOURCE_PATTERN.test(file) && !isTestFile(file) && !/\/premium-[^/]+\//.test(file))
    .sort();
}

const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');

/** Next's resolution of a relative route import: `x.ts`, `x.tsx`, then `x/index.ts`. */
function resolveRouteModule(fromFile: string, specifier: string): string | null {
  const base = path.posix.join(path.posix.dirname(fromFile), specifier);
  const candidates = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
  return candidates.find(candidate => existsSync(path.join(ROOT, candidate))) ?? null;
}

type Analyzed = RouteAnalysis & { aliasOf?: string };

/** Analyzes a route file, following a default re-export to the handler it actually serves. */
function analyzeFile(file: string, route: string, scopeTable: ScopeTable, contracts: ContractIndex): Analyzed {
  const text = read(file);
  const reexport = reexportedDefault(file, text);
  const target = reexport && resolveRouteModule(file, reexport.specifier);
  const targetRoute = target && routeFromFile(target);
  if (!reexport || !target || !targetRoute) return analyzeRouteSource(file, text, route, scopeTable, contracts);
  return {
    ...analyzeRouteSource(target, read(target), targetRoute, scopeTable, contracts, reexport.exportName),
    aliasOf: targetRoute,
  };
}

function overlayRoutes(): Array<{ route: string; file: string }> {
  const premiumDir = path.join(ROOT, 'packages/premium');
  if (!existsSync(premiumDir)) return [];
  return readdirSync(premiumDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(path.join(premiumDir, entry.name, 'package.json')))
    .flatMap(entry => {
      const manifestPath = path.join(premiumDir, entry.name, 'package.json');
      const manifest = overlayManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
      return (manifest.b4mContributions?.apiRouteStubs ?? []).flatMap(stub => {
        const route = routeFromFile(path.posix.join('apps/client', stub.generatedPath));
        return route ? [{ route, file: `${manifest.name} (overlay)` }] : [];
      });
    });
}

function collectRecords(includeOverlays: boolean): { records: RouteRecord[]; unresolved: UnresolvedCall[] } {
  const scopeSources = Object.fromEntries(
    SCOPE_SOURCE_DIRS.flatMap(sourceFiles)
      .filter(file => SCOPE_SOURCE_PATTERN.test(file))
      .map(file => [file, read(file)])
  );
  const scopeTable = buildScopeTable(scopeSources);
  const contracts = contractIndexFromOpenApi(JSON.parse(read(OPENAPI_DOCUMENT)));

  const records: RouteRecord[] = sourceFiles(API_DIR).flatMap(file => {
    const route = routeFromFile(file);
    if (!route) return [];
    return [{ route, file, callers: [], ...analyzeFile(file, route, scopeTable, contracts) }];
  });
  if (includeOverlays) {
    // Overlay sources are not in this tree, so only the path is known.
    records.push(
      ...overlayRoutes().map(({ route, file }) => ({
        route,
        file,
        methods: [],
        acceptsAnyMethod: false,
        auth: ['unknown' as const],
        scopes: [],
        contracted: false,
        callers: [],
      }))
    );
  }

  const unresolved = attachCallers(records);
  return { records, unresolved };
}

/** Fills each record's callers and returns the client paths that no real handler serves. */
function attachCallers(records: RouteRecord[]): UnresolvedCall[] {
  const byRoute = new Map(records.map(record => [record.route, record]));
  const matchers = routeMatchers([...byRoute.keys()]);
  const unresolved: UnresolvedCall[] = [];
  for (const file of sourceFiles(CALLER_DIR)) {
    if (NON_CALLER_FILES.has(file)) continue;
    const caller = path.posix.relative(CALLER_DIR, file);
    const reached = new Set<string>();
    for (const callerPath of extractApiPaths(file, read(file))) {
      const routes = matchCallerPath(callerPath, matchers);
      if (routes.every(isCatchAllRoute)) {
        unresolved.push({ path: formatCallerPath(callerPath), caller });
      } else {
        routes.forEach(route => reached.add(route));
      }
    }
    for (const route of reached) byRoute.get(route)?.callers.push(caller);
  }
  return unresolved;
}

function main(): void {
  const { values } = parseArgs({
    options: {
      out: { type: 'string', default: DEFAULT_OUTPUT },
      'include-overlays': { type: 'boolean', default: false },
    },
  });
  const output = path.resolve(ROOT, values.out);
  if (values['include-overlays'] && output === path.join(ROOT, DEFAULT_OUTPUT)) {
    throw new Error(`--include-overlays output must not go to the committed ${DEFAULT_OUTPUT}; pass --out <path>`);
  }

  const { records, unresolved } = collectRecords(values['include-overlays']);
  writeFileSync(output, renderInventoryMarkdown(records, unresolved));
  console.log(`Wrote ${records.length} routes to ${path.relative(ROOT, output) || output}`);
}

main();
