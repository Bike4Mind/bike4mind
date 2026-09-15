#!/usr/bin/env tsx
/**
 * B4Mv3 #8808 — DB domain deep-import migration codemod.
 *
 * Rewrites @bike4mind/database/src deep imports to root or domain sub-paths.
 * Parses forwarder stubs at packages/database/src/models/*.ts at runtime to
 * build the flat-model → domain mapping table.
 *
 * Usage:
 *   pnpm tsx scripts/codemods/db-domain-migrate-deep-imports.ts [--dry-run] [--scope=<glob>]
 *
 * Default --scope: apps/**\/*.{ts,tsx} b4m-core/**\/*.{ts,tsx} packages/**\/*.{ts,tsx}
 * Excludes: packages/database/** (the package itself) and
 *           scripts/codemods/__tests__/fixtures/** (fixtures contain literal deep paths by design)
 *
 * NOTE: buildDomainMap() is dead code after migration (stubs deleted in #8808).
 * Re-running will find no *.ts files in models/, return an empty map, and throw
 * on any model-specific import it encounters. The codemod is preserved for
 * historical reference and test coverage.
 */

import { Project, SourceFile, QuoteKind } from 'ts-morph';
import path from 'node:path';
import { readFileSync, writeFileSync, globSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Stub parsing — builds flat-model → domain mapping at runtime
// ---------------------------------------------------------------------------

/** Sentinel: model with zero callers — codemod skips any import referencing it. */
export const SKIP = '__skip__';
export type DomainMap = Map<string, string>;

export function buildDomainMap(modelsDir: string): DomainMap {
  const stubFiles = globSync(path.join(modelsDir, '*.ts'));
  const map: DomainMap = new Map();

  for (const stubPath of stubFiles) {
    const name = path.basename(stubPath, '.ts');

    if (name === 'index') continue;

    // Hardcoded: BaseModel is routed to root barrel via explicit re-export in src/index.ts
    if (name === 'BaseModel') {
      map.set(name, '@bike4mind/database');
      continue;
    }

    // Hardcoded: testModelStats has zero callers; skip any occurrences silently
    if (name === 'testModelStats') {
      map.set(name, SKIP);
      continue;
    }

    const content = readFileSync(stubPath, 'utf-8').trim();
    // Both stub shapes start with: export * from './<domain>/<Name>';
    const match = content.match(/^export \* from '\.\/([^/]+)\//);
    if (!match) {
      throw new Error(
        `Unrecognized stub shape in ${path.basename(stubPath)}:\n${content}\n\n` +
          `Expected: export * from './<domain>/<Name>'; (optionally followed by export { default } from ...)\n` +
          `Add a hardcoded override in buildDomainMap() if this stub is intentionally non-standard.`
      );
    }
    map.set(name, `@bike4mind/database/${match[1]}`);
  }

  return map;
}

// ---------------------------------------------------------------------------
// Path-rewrite logic
// ---------------------------------------------------------------------------

const DEEP_PREFIX = '@bike4mind/database/src';

/**
 * Returns the new import path for a given moduleSpec, or null if no rewrite is needed.
 * Throws if a model-specific import references a model not in the domainMap.
 */
export function resolveNewPath(moduleSpec: string, domainMap: DomainMap): string | null {
  if (!moduleSpec.startsWith(DEEP_PREFIX)) return null;

  // @bike4mind/database/src/models/<ModelName>  →  domain sub-path (or root for overrides)
  const modelMatch = moduleSpec.match(/^@bike4mind\/database\/src\/models\/([^/]+)$/);
  if (modelMatch) {
    const modelName = modelMatch[1];
    const domain = domainMap.get(modelName);
    if (domain === undefined) {
      throw new Error(
        `Unknown model "${modelName}" in import "${moduleSpec}".\n` +
          `Stub not found in packages/database/src/models/ — add a hardcoded override in buildDomainMap().`
      );
    }
    if (domain === SKIP) return null;
    return domain;
  }

  // @bike4mind/database/src/models  →  root barrel
  if (moduleSpec === `${DEEP_PREFIX}/models`) return '@bike4mind/database';

  // @bike4mind/database/src/utils/documentdb-compat  →  root barrel (per Q2 decision)
  if (moduleSpec === `${DEEP_PREFIX}/utils/documentdb-compat`) return '@bike4mind/database';

  // Fallback: any other /src/** path (src/types, src/utils/*, etc.) → root barrel
  return '@bike4mind/database';
}

// ---------------------------------------------------------------------------
// Core migration — exported for tests
// ---------------------------------------------------------------------------

export interface MigrateResult {
  modified: boolean;
}

/** Migrate a single SourceFile in-memory. Does NOT save to disk. */
export function migrateSourceFile(sourceFile: SourceFile, domainMap: DomainMap): MigrateResult {
  let modified = false;

  for (const decl of sourceFile.getImportDeclarations()) {
    const moduleSpec = decl.getModuleSpecifierValue();
    const newPath = resolveNewPath(moduleSpec, domainMap);
    if (!newPath) continue;

    // Capture default import before mutation (belt-and-suspenders: setModuleSpecifier
    // modifies only the string literal but we re-apply to guard against ts-morph edge cases).
    // Note: domain barrels use `export *` which does NOT re-export default exports, so any
    // surviving default import here must target the root barrel (@bike4mind/database), which
    // does propagate defaults. In practice, no domain-routed models had default-import callers
    // after #8808 — all were converted to named imports during migration.
    const defaultImport = decl.getDefaultImport()?.getText();
    decl.setModuleSpecifier(newPath);
    if (defaultImport) decl.setDefaultImport(defaultImport);

    modified = true;
  }

  for (const decl of sourceFile.getExportDeclarations()) {
    const moduleSpec = decl.getModuleSpecifierValue();
    if (!moduleSpec) continue;
    const newPath = resolveNewPath(moduleSpec, domainMap);
    if (!newPath) continue;

    decl.setModuleSpecifier(newPath);
    modified = true;
  }

  return { modified };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(): { dryRun: boolean; scope: string[] } {
  const args = process.argv.slice(2);
  let dryRun = false;
  const scope: string[] = [];

  for (const arg of args) {
    if (arg === '--dry-run') dryRun = true;
    else if (arg.startsWith('--scope=')) scope.push(arg.slice('--scope='.length));
  }

  const defaultScope = ['apps/**/*.{ts,tsx}', 'b4m-core/**/*.{ts,tsx}', 'packages/**/*.{ts,tsx}'];
  return { dryRun, scope: scope.length ? scope : defaultScope };
}

async function main() {
  const { dryRun, scope } = parseArgs();
  const repoRoot = path.resolve(import.meta.dirname, '../..');
  const modelsDir = path.join(repoRoot, 'packages/database/src/models');

  const domainMap = buildDomainMap(modelsDir);

  const excluded = [
    path.join(repoRoot, 'packages/database') + path.sep,
    path.join(repoRoot, 'scripts/codemods/__tests__/fixtures') + path.sep,
  ];

  const filePaths: string[] = [];
  for (const pattern of scope) {
    const matches = globSync(path.join(repoRoot, pattern));
    for (const absPath of matches) {
      if (!excluded.some(ex => absPath.startsWith(ex))) {
        filePaths.push(absPath);
      }
    }
  }

  const modifiedFiles: string[] = [];

  for (const absPath of filePaths) {
    // One Project per file — keeps peak memory constant
    const project = new Project({
      useInMemoryFileSystem: true,
      manipulationSettings: { quoteKind: QuoteKind.Single },
    });

    const content = readFileSync(absPath, 'utf-8');
    const sf = project.createSourceFile(absPath, content);
    const { modified } = migrateSourceFile(sf, domainMap);

    if (modified) {
      const rel = path.relative(repoRoot, absPath);
      modifiedFiles.push(rel);
      if (!dryRun) writeFileSync(absPath, sf.getFullText(), 'utf-8');
    }
  }

  console.log(`\ndb-domain migration${dryRun ? ' (dry-run)' : ''}`);
  console.log(`Files ${dryRun ? 'would be ' : ''}modified: ${modifiedFiles.length}`);
  if (modifiedFiles.length) modifiedFiles.forEach(f => console.log(`  ${dryRun ? '[dry]' : '[mod]'} ${f}`));
  console.log('');
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('db-domain-migrate-deep-imports.ts') ||
    process.argv[1].endsWith('db-domain-migrate-deep-imports.js'));

if (isMain) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
