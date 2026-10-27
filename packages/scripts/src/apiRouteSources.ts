/**
 * Reads the route tree from disk for the analysis in apiRouteInventory.ts. Shared by
 * generateApiRouteInventory.ts and checkRouteScopePosture.test.ts.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzeRouteSource,
  buildScopeTable,
  contractIndexFromOpenApi,
  isTestFile,
  reexportedDefault,
  routeFromFile,
  type ContractIndex,
  type RouteAnalysis,
  type ScopeTable,
} from './apiRouteInventory';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const API_DIR = 'apps/client/pages/api';
const OPENAPI_DOCUMENT = 'apps/client/public/openapi.json';
const SCOPE_SOURCE_DIRS = ['b4m-core/common/src', 'apps/client/server'];
const SCOPE_SOURCE_PATTERN = /(UserApiKeyTypes|Scopes)\.ts$/;
const SOURCE_PATTERN = /\.(ts|tsx)$/;

/** Repo-relative source files under `dir`, skipping tests and the gitignored premium-* codegen. */
export function sourceFiles(dir: string): string[] {
  const absolute = path.join(ROOT, dir);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { recursive: true, encoding: 'utf8' })
    .map(entry => path.posix.join(dir, entry.split(path.sep).join('/')))
    .filter(file => SOURCE_PATTERN.test(file) && !isTestFile(file) && !/\/premium-[^/]+\//.test(file))
    .sort();
}

export const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');

/** Next's resolution of a relative route import: `x.ts`, `x.tsx`, then `x/index.ts`. */
function resolveRouteModule(fromFile: string, specifier: string): string | null {
  const base = path.posix.join(path.posix.dirname(fromFile), specifier);
  const candidates = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
  return candidates.find(candidate => existsSync(path.join(ROOT, candidate))) ?? null;
}

export type Analyzed = RouteAnalysis & { aliasOf?: string; analyzedFile: string };

/** Analyzes a route file, following a default re-export to the handler it actually serves. */
function analyzeFile(file: string, route: string, scopeTable: ScopeTable, contracts: ContractIndex): Analyzed {
  const text = read(file);
  const reexport = reexportedDefault(file, text);
  const target = reexport && resolveRouteModule(file, reexport.specifier);
  const targetRoute = target && routeFromFile(target);
  if (!reexport || !target || !targetRoute) {
    return { ...analyzeRouteSource(file, text, route, scopeTable, contracts), analyzedFile: file };
  }
  return {
    ...analyzeRouteSource(target, read(target), targetRoute, scopeTable, contracts, reexport.exportName),
    aliasOf: targetRoute,
    analyzedFile: target,
  };
}

export type AnalyzedRoute = Analyzed & { route: string; file: string };

/** Every route under apps/client/pages/api, analyzed. */
export function analyzeApiRoutes(): AnalyzedRoute[] {
  const scopeSources = Object.fromEntries(
    SCOPE_SOURCE_DIRS.flatMap(sourceFiles)
      .filter(file => SCOPE_SOURCE_PATTERN.test(file))
      .map(file => [file, read(file)])
  );
  const scopeTable = buildScopeTable(scopeSources);
  const contracts = contractIndexFromOpenApi(JSON.parse(read(OPENAPI_DOCUMENT)));

  return sourceFiles(API_DIR).flatMap(file => {
    const route = routeFromFile(file);
    if (!route) return [];
    return [{ route, file, ...analyzeFile(file, route, scopeTable, contracts) }];
  });
}
