/**
 * Writes docs/api-route-inventory.md from the route files on disk. Analysis lives in
 * apiRouteInventory.ts; this file only gathers sources and writes the result.
 *
 *   pnpm --filter @bike4mind/scripts api-routes:inventory
 *   pnpm --filter @bike4mind/scripts api-routes:inventory --include-overlays --out /tmp/routes.md
 *
 * Overlay routes (b4mContributions.apiRouteStubs of the packages/premium/* checkouts) are opt-in and
 * may only be written outside the repo: this repo is public and the overlays are not. They are listed
 * by path only; following each stub into its overlay package is not implemented.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import {
  extractApiPaths,
  formatCallerPath,
  isFallbackRoute,
  isInsideRepo,
  matchCallerPath,
  renderInventoryMarkdown,
  routeFromFile,
  routeMatchers,
  type RouteRecord,
  type UnresolvedCall,
} from './apiRouteInventory';
import { analyzeApiRoutes, read, ROOT, sourceFiles } from './apiRouteSources';

const CALLER_DIR = 'apps/client/app';
const DEFAULT_OUTPUT = 'docs/api-route-inventory.md';

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
  const records: RouteRecord[] = analyzeApiRoutes().map(analysis => ({ ...analysis, callers: [] }));
  if (includeOverlays) {
    // Path only: the stubs re-export from the overlay packages, which the analyzer does not follow.
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
      if (routes.every(isFallbackRoute)) {
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
  // pnpm --filter runs scripts from the package dir; INIT_CWD is where the user typed the command.
  const output =
    values.out === DEFAULT_OUTPUT
      ? path.join(ROOT, DEFAULT_OUTPUT)
      : path.resolve(process.env.INIT_CWD ?? process.cwd(), values.out);
  if (
    values['include-overlays'] &&
    isInsideRepo(path.join(realpathSync(path.dirname(output)), path.basename(output)), realpathSync(ROOT))
  ) {
    throw new Error('--include-overlays lists private overlay routes; pass an --out path outside this public repo');
  }

  const { records, unresolved } = collectRecords(values['include-overlays']);
  writeFileSync(output, renderInventoryMarkdown(records, unresolved));
  console.log(`Wrote ${records.length} routes to ${path.relative(ROOT, output) || output}`);
}

main();
