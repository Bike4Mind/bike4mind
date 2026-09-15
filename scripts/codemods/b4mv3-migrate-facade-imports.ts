#!/usr/bin/env tsx
/**
 * B4Mv3 facade import migration codemod.
 *
 * Usage:
 *   pnpm tsx scripts/codemods/b4mv3-migrate-facade-imports.ts \
 *     --slice=<observability|fab-pipeline|llm-adapters|auth> \
 *     [--dry-run] \
 *     [--scope=<glob>]
 *
 * Default --scope: apps/**\/*.{ts,tsx} b4m-core/**\/*.{ts,tsx} packages/**\/*.{ts,tsx}
 * (mirrors the ESLint B4Mv3 block's files/ignores exactly — excludes b4m-core/{utils,services,common})
 *
 * Path-scoping design note
 * ------------------------
 * The default scope intentionally excludes b4m-core/services/** and b4m-core/utils/** because
 * those packages are themselves facade re-exporters and are exempt from the ESLint
 * no-restricted-imports error rule. Files in those directories that import Logger/etc.
 * directly from @bike4mind/utils still work (the facade re-export chain is intact) and are
 * migrated manually as a separate step rather than via this codemod, to avoid silently
 * rewriting facade barrel files. Use --scope to override if a targeted sweep is needed,
 * e.g.: --scope="b4m-core/services/src/emailIngestionService/**"
 */

import { Project, SourceFile, ImportDeclaration, ExportDeclaration, QuoteKind } from 'ts-morph';
import path from 'node:path';
import { readFileSync, writeFileSync, globSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Symbol → target-package mapping per slice
// ---------------------------------------------------------------------------

type SliceName = 'observability' | 'fab-pipeline' | 'llm-adapters' | 'auth';

interface SliceConfig {
  /** Named imports from @bike4mind/utils or @bike4mind/services that move */
  symbolMap: Map<string, string>; // symbol → target package
  /** Full-path rewrites (e.g. @bike4mind/utils/llm/backend → @bike4mind/llm-adapters/backend) */
  pathRewrites: Array<{ from: string; to: string }>;
}

export const SLICE_CONFIGS: Record<SliceName, SliceConfig> = {
  observability: {
    symbolMap: new Map(['Logger', 'ILogger', 'LogLevel'].map(s => [s, '@bike4mind/observability'])),
    pathRewrites: [],
  },
  'fab-pipeline': {
    symbolMap: new Map(
      [
        'SmartChunker',
        'ChunkSchema',
        'Chunk',
        'URL_REGEX',
        'detectURLs',
        'hasURLs',
        'urlExists',
        'fetchAndParseURL',
        'validateUrlForFetch',
        'isPrivateIP',
        'isPrivateOrInternalHostname',
        'EmbeddingFactory',
        'EmbeddingConfig',
        'EmbeddingService',
        'EmbeddingModelProvider',
        'EmbeddingModelInfo',
        'getProviderFromModel',
        'BedrockEmbeddingService',
        'BedrockCredentials',
        'BEDROCK_EMBEDDING_MODEL_MAP',
        'OpenAIEmbeddingService',
        'OPENAI_EMBEDDING_MODEL_MAP',
        'VoyageAIEmbeddingProvider',
        'VOYAGEAI_EMBEDDING_MODEL_MAP',
        'BaseStorage',
        'S3Storage',
      ].map(s => [s, '@bike4mind/fab-pipeline'])
    ),
    pathRewrites: [],
  },
  'llm-adapters': {
    symbolMap: new Map(
      [
        'ApiKeyTable',
        'getLlmByModel',
        'getAvailableModels',
        'getExpiringModels',
        'logExpiringModels',
        'resolveDeprecatedModelId',
        'PipelineTimer',
        'ICompletionBackend',
        'ICompletionOptions',
        'ICompletionOptionTools',
        'ICompletionResponse',
        'ICompletionResponseChunk',
        'ITokenizingBackend',
        'CompletionInfo',
        'CompletionCallback',
        'IChoice',
        'IChoiceEnd',
        'IChoiceStream',
        'IChoiceEndStop',
        'IChoiceEndComplete',
        'IChoiceEndToolUse',
        'ChoiceStatus',
        'ChoiceEndReason',
        'DEFAULT_MAX_TOOL_CALLS',
        'DEFAULT_MAX_PARALLEL_TOOLS',
        'OllamaBackend',
        'OpenAIBackend',
        'AnthropicBackend',
        'AnthropicBedrockBackend',
        'AnthropicBatchService',
        'AWSBackend',
        'BFLBackend',
        'GeminiBackend',
        'UndifferentiatedBedrockBackend',
        'XAIBackend',
        'BatchTransformRequest',
        'BatchStatus',
        'BatchItemResult',
        'BatchSubmitResult',
      ].map(s => [s, '@bike4mind/llm-adapters'])
    ),
    pathRewrites: [{ from: '@bike4mind/utils/llm/backend', to: '@bike4mind/llm-adapters/backend' }],
  },
  auth: {
    symbolMap: new Map([['AuthTokenGeneratorService', '@bike4mind/auth']]),
    pathRewrites: [
      { from: '@bike4mind/services/apiKeyService', to: '@bike4mind/auth/apiKeyService' },
      { from: '@bike4mind/services/mfaService/utils', to: '@bike4mind/auth/mfaService/utils' },
      { from: '@bike4mind/services/utils/crypto', to: '@bike4mind/auth/crypto' },
    ],
  },
};

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

function parseArgs(): { slice: SliceName; dryRun: boolean; scope: string[]; usingDefaultScope: boolean } {
  const args = process.argv.slice(2);
  let slice: SliceName | undefined;
  let dryRun = false;
  const scope: string[] = [];

  for (const arg of args) {
    if (arg.startsWith('--slice=')) {
      const val = arg.slice('--slice='.length);
      if (!['observability', 'fab-pipeline', 'llm-adapters', 'auth'].includes(val)) {
        console.error(`Unknown slice: ${val}`);
        process.exit(1);
      }
      slice = val as SliceName;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg.startsWith('--scope=')) {
      scope.push(arg.slice('--scope='.length));
    }
  }

  if (!slice) {
    console.error('--slice is required');
    process.exit(1);
  }

  const defaultScope = ['apps/**/*.{ts,tsx}', 'b4m-core/**/*.{ts,tsx}', 'packages/**/*.{ts,tsx}'];

  const usingDefaultScope = scope.length === 0;
  return { slice, dryRun, scope: scope.length ? scope : defaultScope, usingDefaultScope };
}

// ---------------------------------------------------------------------------
// Core migration logic (exported for tests)
// ---------------------------------------------------------------------------

export interface MigrateResult {
  modified: boolean;
  unhandled: string[];
}

/**
 * Migrate a single SourceFile in-memory. Does NOT save to disk.
 * Returns whether the file was modified and any unhandled import paths.
 */
export function migrateSourceFile(sourceFile: SourceFile, config: SliceConfig): MigrateResult {
  const unhandled: string[] = [];
  let modified = false;

  // --- ImportDeclarations ---
  for (const decl of sourceFile.getImportDeclarations()) {
    const result = migrateDeclaration(decl, config, unhandled);
    if (result) modified = true;
  }

  // --- ExportDeclarations (re-exports: export { X } from '...') ---
  for (const decl of sourceFile.getExportDeclarations()) {
    const result = migrateExportDeclaration(decl, config, unhandled);
    if (result) modified = true;
  }

  return { modified, unhandled };
}

// ---------------------------------------------------------------------------
// ImportDeclaration handler
// ---------------------------------------------------------------------------

function migrateDeclaration(decl: ImportDeclaration, config: SliceConfig, unhandled: string[]): boolean {
  const moduleSpec = decl.getModuleSpecifierValue();

  // Full-path rewrite (e.g. @bike4mind/utils/llm/backend)
  for (const { from, to } of config.pathRewrites) {
    if (moduleSpec === from || moduleSpec.startsWith(from + '/')) {
      const newSpec = to + moduleSpec.slice(from.length);
      decl.setModuleSpecifier(newSpec);
      return true;
    }
  }

  // Named-import rewrite for @bike4mind/utils or @bike4mind/services
  if (moduleSpec !== '@bike4mind/utils' && moduleSpec !== '@bike4mind/services') {
    return false;
  }

  const namedImports = decl.getNamedImports();
  if (namedImports.length === 0) {
    // namespace or default import — can't auto-migrate
    unhandled.push(moduleSpec);
    return false;
  }

  // Partition specifiers: deprecated vs non-deprecated
  const deprecated: typeof namedImports = [];
  const keep: typeof namedImports = [];

  for (const spec of namedImports) {
    // The canonical name (before alias) is what we look up in symbolMap
    const canonical = spec.getNameNode().getText();
    if (config.symbolMap.has(canonical)) {
      deprecated.push(spec);
    } else {
      keep.push(spec);
    }
  }

  if (deprecated.length === 0) return false;

  // Group deprecated by target package (handles same-facade, different-target edge case)
  const byTarget = new Map<string, typeof deprecated>();
  for (const spec of deprecated) {
    const canonical = spec.getNameNode().getText();
    const target = config.symbolMap.get(canonical)!;
    if (!byTarget.has(target)) byTarget.set(target, []);
    byTarget.get(target)!.push(spec);
  }

  const isTypeImport = decl.isTypeOnly();

  if (keep.length === 0) {
    // Pure rewrite: replace the original declaration(s)
    const targets = [...byTarget.entries()];
    const [firstTarget, firstSpecs] = targets[0];
    rewriteSpecifiers(decl, firstTarget, firstSpecs, isTypeImport);

    let insertAfter = decl;
    for (let i = 1; i < targets.length; i++) {
      const [tgt, specs] = targets[i];
      const newDecl = insertAfter.getSourceFile().insertImportDeclaration(insertAfter.getChildIndex() + 1, {
        moduleSpecifier: tgt,
        isTypeOnly: isTypeImport && specs.every(s => !s.isTypeOnly()),
        namedImports: buildNamedImportStructures(specs, isTypeImport),
      });
      insertAfter = newDecl;
    }
  } else {
    // Mixed import: keep the original (stripped of deprecated), add new decls for deprecated.
    // Capture spec data BEFORE removal since ts-morph invalidates nodes after removal.
    const byTargetData = new Map<string, Array<{ name: string; alias?: string; isTypeOnly?: boolean }>>();
    for (const [tgt, specs] of byTarget.entries()) {
      byTargetData.set(tgt, buildNamedImportStructures(specs, isTypeImport));
    }

    for (const spec of deprecated) {
      spec.remove();
    }

    let insertAfter = decl;
    for (const [tgt, namedImports] of byTargetData.entries()) {
      const allTypeOnly = namedImports.every(ni => ni.isTypeOnly);
      const newDecl = insertAfter.getSourceFile().insertImportDeclaration(insertAfter.getChildIndex() + 1, {
        moduleSpecifier: tgt,
        isTypeOnly: isTypeImport && allTypeOnly,
        namedImports,
      });
      insertAfter = newDecl;
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// ExportDeclaration handler
// ---------------------------------------------------------------------------

function migrateExportDeclaration(decl: ExportDeclaration, config: SliceConfig, unhandled: string[]): boolean {
  const moduleSpec = decl.getModuleSpecifierValue();
  if (!moduleSpec) return false;

  // Full-path rewrite
  for (const { from, to } of config.pathRewrites) {
    if (moduleSpec === from || moduleSpec.startsWith(from + '/')) {
      const newSpec = to + moduleSpec.slice(from.length);
      decl.setModuleSpecifier(newSpec);
      return true;
    }
  }

  if (moduleSpec !== '@bike4mind/utils' && moduleSpec !== '@bike4mind/services') {
    return false;
  }

  const namedExports = decl.getNamedExports();
  if (namedExports.length === 0) {
    unhandled.push(moduleSpec);
    return false;
  }

  const deprecated: typeof namedExports = [];
  const keep: typeof namedExports = [];

  for (const spec of namedExports) {
    const canonical = spec.getNameNode().getText();
    if (config.symbolMap.has(canonical)) {
      deprecated.push(spec);
    } else {
      keep.push(spec);
    }
  }

  if (deprecated.length === 0) return false;

  const byTarget = new Map<string, typeof deprecated>();
  for (const spec of deprecated) {
    const canonical = spec.getNameNode().getText();
    const target = config.symbolMap.get(canonical)!;
    if (!byTarget.has(target)) byTarget.set(target, []);
    byTarget.get(target)!.push(spec);
  }

  const isTypeExport = decl.isTypeOnly();

  if (keep.length === 0) {
    const targets = [...byTarget.entries()];
    const [firstTarget, firstSpecs] = targets[0];
    decl.setModuleSpecifier(firstTarget);
    if (firstSpecs.some(s => s.getAliasNode())) {
      // preserve aliases; just update module specifier — already done
    }

    let insertAfter = decl;
    for (let i = 1; i < targets.length; i++) {
      const [tgt, specs] = targets[i];
      const newDecl = insertAfter.getSourceFile().insertExportDeclaration(insertAfter.getChildIndex() + 1, {
        moduleSpecifier: tgt,
        isTypeOnly: isTypeExport,
        namedExports: specs.map(s => {
          const name = s.getNameNode().getText();
          const alias = s.getAliasNode()?.getText();
          return alias ? { name, alias } : { name };
        }),
      });
      insertAfter = newDecl;
    }
  } else {
    for (const spec of deprecated) {
      spec.remove();
    }

    let insertAfter = decl;
    for (const [tgt, specs] of byTarget.entries()) {
      const newDecl = insertAfter.getSourceFile().insertExportDeclaration(insertAfter.getChildIndex() + 1, {
        moduleSpecifier: tgt,
        isTypeOnly: isTypeExport,
        namedExports: specs.map(s => {
          const name = s.getNameNode().getText();
          const alias = s.getAliasNode()?.getText();
          return alias ? { name, alias } : { name };
        }),
      });
      insertAfter = newDecl;
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rewriteSpecifiers(
  decl: ImportDeclaration,
  targetPkg: string,
  specs: ReturnType<ImportDeclaration['getNamedImports']>,
  isTypeImport: boolean
): void {
  decl.setModuleSpecifier(targetPkg);
  // Remove all named imports, re-add only the target ones (preserves aliases + inline type)
  const namedImports = decl.getNamedImports();
  for (const ni of namedImports) {
    if (!specs.some(s => s === ni)) {
      ni.remove();
    }
  }
  // If statement-level isTypeOnly was false but all specifiers have inline `type`, keep them
}

function buildNamedImportStructures(
  specs: ReturnType<ImportDeclaration['getNamedImports']>,
  statementIsType: boolean
): Array<{ name: string; alias?: string; isTypeOnly?: boolean }> {
  return specs.map(spec => {
    const name = spec.getNameNode().getText();
    const aliasNode = spec.getAliasNode();
    const alias = aliasNode ? aliasNode.getText() : undefined;
    // Preserve inline `type` modifier if present and statement-level is not already type-only
    const isTypeOnly = !statementIsType && spec.isTypeOnly() ? true : undefined;
    return alias ? { name, alias, isTypeOnly } : { name, isTypeOnly };
  });
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function main() {
  const { slice, dryRun, scope, usingDefaultScope } = parseArgs();
  const config = SLICE_CONFIGS[slice];

  const repoRoot = path.resolve(import.meta.dirname, '../..');

  // When using the default scope, exclude facade re-exporter packages to avoid
  // accidentally rewriting their barrel files. When --scope is explicitly provided,
  // the caller knows what they're targeting, so skip the exclusion.
  const excluded = usingDefaultScope ? ['b4m-core/utils/', 'b4m-core/services/', 'b4m-core/common/'] : [];

  // Collect matching files using Node's built-in globSync (Node 22+)
  const filePaths: string[] = [];
  for (const pattern of scope) {
    const absPattern = path.join(repoRoot, pattern);
    const matches = globSync(absPattern);
    for (const absPath of matches) {
      if (!excluded.some(ex => absPath.startsWith(path.join(repoRoot, ex)))) {
        filePaths.push(absPath);
      }
    }
  }

  const modifiedFiles: string[] = [];
  const allUnhandled: string[] = [];

  for (const absPath of filePaths) {
    // One Project per file keeps peak memory constant (ts-morph does not accumulate state)
    const project = new Project({
      useInMemoryFileSystem: true,
      manipulationSettings: { quoteKind: QuoteKind.Single },
    });

    const content = readFileSync(absPath, 'utf-8');
    const sf = project.createSourceFile(absPath, content);

    const { modified: changed, unhandled } = migrateSourceFile(sf, config);

    if (changed) {
      const rel = path.relative(repoRoot, absPath);
      modifiedFiles.push(rel);
      if (!dryRun) {
        writeFileSync(absPath, sf.getFullText(), 'utf-8');
      }
    }
    if (unhandled.length) {
      allUnhandled.push(`${path.relative(repoRoot, absPath)}: ${unhandled.join(', ')}`);
    }
  }

  console.log(`\nSlice: ${slice}${dryRun ? ' (dry-run)' : ''}`);
  console.log(`Files ${dryRun ? 'would be ' : ''}modified: ${modifiedFiles.length}`);
  if (modifiedFiles.length) {
    modifiedFiles.forEach(f => console.log(`  ${dryRun ? '[dry]' : '[mod]'} ${f}`));
  }

  if (allUnhandled.length) {
    console.log(`\nUnhandled imports (manual review required):`);
    allUnhandled.forEach(u => console.log(`  [skip] ${u}`));
  }

  console.log('');
}

// Only run CLI when executed directly (not when imported by tests)
const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('b4mv3-migrate-facade-imports.ts') ||
    process.argv[1].endsWith('b4mv3-migrate-facade-imports.js'));

if (isMain) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
