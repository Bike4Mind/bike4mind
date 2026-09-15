#!/usr/bin/env tsx
/**
 * Bundle Help Content Script
 *
 * Copies markdown files from docs-site/docs/ into one of two output roots for
 * production serving, chosen by each index entry's accessLevel:
 *
 *   public -> apps/client/public/help-content/            (unauthenticated static assets)
 *   admin  -> apps/client/app/generated/help-content-admin/ (not web-reachable; read
 *             only by an authenticated API route)
 *
 * The split is the point: anything under public/ is readable by anyone who
 * guesses the URL, so an admin-only article must never land there. The
 * "unset accessLevel counts as public" rule below must stay in sync with
 * filterHelpIndex in apps/client/pages/api/help/index.ts, which gates the index
 * the same way.
 *
 * Uses real file copies (not symlinks) so content survives Lambda deployment via
 * OpenNext/SST.
 *
 * Only bundles files that are referenced in the help-index.json, plus any media
 * assets (images, GIFs, demo videos) those articles reference - copied with the
 * same docs-root-relative path so relative references resolve under the serving
 * root at runtime. An asset referenced by at least one public article goes to the
 * public root (a public article already exposes it, so an admin copy would be dead
 * weight); one referenced only by admin articles stays admin-only. Existence is
 * validate-help-content.ts's job; its format and size rules (mediaPolicyError) are
 * re-checked here as a second line of defense, because help:build runs the index
 * and bundle steps WITHOUT help:validate - so nothing else stands between a bad
 * asset and the deploy bundle at that point.
 *
 * Usage: pnpm --filter @bike4mind/scripts help:bundle-content
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { HelpIndex, HelpIndexEntry } from './types.js';
import { ADMIN_HELP_CONTENT_DIR, PUBLIC_HELP_CONTENT_DIR, isPublicAccessLevel } from './utils.js';
import {
  extractMarkdownLinks,
  hasAssetExtension,
  isExternal,
  mediaPolicyError,
  resolveAssetPath,
} from './validate-help-content.js';

// ES module compatibility
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Paths relative to project root
const DOCS_ROOT = path.resolve(__dirname, '../../../docs-site/docs');
const CLIENT_ROOT = path.resolve(__dirname, '../../../apps/client');
const OUTPUT_DIR = path.join(CLIENT_ROOT, PUBLIC_HELP_CONTENT_DIR);
const ADMIN_OUTPUT_DIR = path.join(CLIENT_ROOT, ADMIN_HELP_CONTENT_DIR);
const INDEX_PATH = path.resolve(__dirname, '../../../apps/client/app/generated/help-index.json');

/**
 * Copy source file to dest, replacing any existing file or symlink.
 */
function copyFile(sourcePath: string, destPath: string): void {
  // Remove existing file/symlink if it exists
  try {
    const stats = fs.lstatSync(destPath);
    if (stats) {
      fs.unlinkSync(destPath);
    }
  } catch {
    // Path doesn't exist, which is fine
  }

  fs.copyFileSync(sourcePath, destPath);
}

/** Size in bytes, or undefined when the file can't be stat'd (mediaPolicyError treats that as a rejection). */
function fileSize(absPath: string): number | undefined {
  try {
    return fs.statSync(absPath).size;
  } catch {
    return undefined;
  }
}

/**
 * Check if dest is an up-to-date copy of source (not a symlink, same mtime).
 */
function isUpToDate(destPath: string, sourcePath: string): boolean {
  try {
    const destStats = fs.lstatSync(destPath);
    // If it's a symlink, it needs to be replaced with a real copy
    if (destStats.isSymbolicLink()) return false;
    const sourceStats = fs.statSync(sourcePath);
    return destStats.mtimeMs >= sourceStats.mtimeMs;
  } catch {
    return false;
  }
}

/** A missing accessLevel means public, matching filterHelpIndex in apps/client/pages/api/help/index.ts. */
function isPublicEntry(entry: HelpIndexEntry): boolean {
  return isPublicAccessLevel(entry.accessLevel);
}

type BundleScope = 'public' | 'admin';

/** One output root plus the tallies and expected-file set that belong to it. */
interface BundleTarget {
  scope: BundleScope;
  root: string;
  /** Absolute dest paths this run wrote or verified; anything else under `root` is stale. */
  expected: Set<string>;
  articlesCopied: number;
  articlesSkipped: number;
  assetsCopied: number;
  assetsSkipped: number;
}

function makeTarget(scope: BundleScope, root: string): BundleTarget {
  return {
    scope,
    root,
    expected: new Set<string>(),
    articlesCopied: 0,
    articlesSkipped: 0,
    assetsCopied: 0,
    assetsSkipped: 0,
  };
}

export interface BundleOptions {
  /** Overridable roots for testing; default to the real repo locations. */
  docsRoot?: string;
  outputDir?: string;
  adminOutputDir?: string;
  indexPath?: string;
}

/**
 * Main bundle function
 */
export async function bundleHelpContent(opts: BundleOptions = {}): Promise<void> {
  const docsRoot = opts.docsRoot ?? DOCS_ROOT;
  const outputDir = opts.outputDir ?? OUTPUT_DIR;
  const adminOutputDir = opts.adminOutputDir ?? ADMIN_OUTPUT_DIR;
  const indexPath = opts.indexPath ?? INDEX_PATH;

  console.log('Bundling help content (file copies)...');
  console.log(`Docs root: ${docsRoot}`);
  console.log(`Public output dir: ${outputDir}`);
  console.log(`Admin output dir: ${adminOutputDir}`);
  console.log(`Index path: ${indexPath}`);

  // Read the help index to know which files to bundle
  if (!fs.existsSync(indexPath)) {
    throw new Error('help-index.json not found. Run help:build-index first.');
  }

  const indexContent = fs.readFileSync(indexPath, 'utf-8');
  const helpIndex: HelpIndex = JSON.parse(indexContent);

  const targets: Record<BundleScope, BundleTarget> = {
    public: makeTarget('public', outputDir),
    admin: makeTarget('admin', adminOutputDir),
  };

  // Get list of files to bundle from the index, each paired with its output root
  const articles = helpIndex.entries.map(entry => ({
    relPath: entry.filePath,
    target: isPublicEntry(entry) ? targets.public : targets.admin,
  }));
  const adminArticleCount = articles.filter(article => article.target.scope === 'admin').length;
  const publicArticleCount = articles.length - adminArticleCount;

  console.log(
    `Found ${articles.length} files in help index (${publicArticleCount} public, ${adminArticleCount} admin)`
  );

  // Ensure output directories exist. The admin root is only created when there is
  // something to put in it, so a fully public corpus leaves no empty directory.
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  if (adminArticleCount > 0 && !fs.existsSync(adminOutputDir)) {
    fs.mkdirSync(adminOutputDir, { recursive: true });
  }

  let errorCount = 0;

  /**
   * Copy one docs-root-relative path into a target root and record it as expected
   * there, so the per-root stale sweep keeps it. `noun` only shapes the log lines.
   */
  function copyInto(target: BundleTarget, relPath: string, noun: 'file' | 'asset'): 'copied' | 'skipped' | 'error' {
    const sourcePath = path.join(docsRoot, relPath);
    const destPath = path.join(target.root, relPath);
    target.expected.add(destPath);

    // Ensure destination directory exists
    const destDir = path.dirname(destPath);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    if (!fs.existsSync(sourcePath)) {
      console.error(`Source ${noun} not found: ${sourcePath}`);
      return 'error';
    }

    // Check if dest is already an up-to-date copy
    if (isUpToDate(destPath, sourcePath)) {
      return 'skipped';
    }

    try {
      copyFile(sourcePath, destPath);
      console.log(`  Copied ${noun} (${target.scope}): ${relPath}`);
      return 'copied';
    } catch (error) {
      console.error(`Error copying ${noun} ${relPath}:`, error);
      return 'error';
    }
  }

  for (const { relPath, target } of articles) {
    const outcome = copyInto(target, relPath, 'file');
    if (outcome === 'copied') target.articlesCopied++;
    else if (outcome === 'skipped') target.articlesSkipped++;
    else errorCount++;
  }

  // Collect media/assets referenced by the bundled articles, remembering which root
  // each belongs in. Broken or escaping references are skipped silently here - the
  // validator reports them as errors. Format/size violations are skipped loudly:
  // this is the last gate before the file lands in the deploy bundle.
  const assetScopes = new Map<string, BundleScope>();
  for (const { relPath: file, target } of articles) {
    const sourcePath = path.join(docsRoot, file);
    if (!fs.existsSync(sourcePath)) continue;
    const content = fs.readFileSync(sourcePath, 'utf-8');
    for (const link of extractMarkdownLinks(content)) {
      const pathPart = link.target.split('#')[0];
      if (!pathPart || isExternal(pathPart)) continue;
      if (!link.isImage && !hasAssetExtension(pathPart)) continue;
      const absSource = resolveAssetPath(pathPart, path.dirname(sourcePath), docsRoot);
      if (!absSource || !fs.existsSync(absSource)) continue;
      const policyError = mediaPolicyError(pathPart, { isImage: link.isImage, readSize: () => fileSize(absSource) });
      if (policyError) {
        console.error(`Refusing to bundle asset referenced by ${file}: ${policyError}`);
        errorCount++;
        continue;
      }
      const assetRelPath = path.relative(docsRoot, absSource);
      // A single public reference is enough to make the asset public; only assets no
      // public article touches are admin-only.
      if (assetScopes.get(assetRelPath) !== 'public') {
        assetScopes.set(assetRelPath, target.scope);
      }
    }
  }

  for (const [relPath, scope] of assetScopes) {
    const target = targets[scope];
    const outcome = copyInto(target, relPath, 'asset');
    if (outcome === 'copied') target.assetsCopied++;
    else if (outcome === 'skipped') target.assetsSkipped++;
    else errorCount++;
  }

  // Clean up stale files (files/symlinks that exist but aren't in the index). Both
  // roots are swept: an article that flips public -> admin has to lose its public
  // copy, or the accessLevel change means nothing.
  let removedCount = 0;
  function cleanupTarget(target: BundleTarget): void {
    const walk = (dir: string): void => {
      if (!fs.existsSync(dir)) return;

      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
          // Remove empty directories
          try {
            const remaining = fs.readdirSync(fullPath);
            if (remaining.length === 0) {
              fs.rmdirSync(fullPath);
            }
          } catch {
            // Directory might not exist or have permission issues
          }
        } else if (!target.expected.has(fullPath) && entry.name !== '.gitkeep') {
          fs.unlinkSync(fullPath);
          removedCount++;
          console.log(`  Removed stale (${target.scope}): ${path.relative(target.root, fullPath)}`);
        }
      }
    };

    walk(target.root);
  }

  for (const target of Object.values(targets)) {
    cleanupTarget(target);
  }

  const adminAssetCount = [...assetScopes.values()].filter(scope => scope === 'admin').length;

  console.log(`\nSummary:`);
  console.log(`  Public: ${targets.public.articlesCopied} copied, ${targets.public.articlesSkipped} up-to-date`);
  console.log(`  Admin: ${targets.admin.articlesCopied} copied, ${targets.admin.articlesSkipped} up-to-date`);
  console.log(
    `  Public assets: ${targets.public.assetsCopied} copied, ${targets.public.assetsSkipped} up-to-date (${assetScopes.size - adminAssetCount} referenced)`
  );
  console.log(
    `  Admin assets: ${targets.admin.assetsCopied} copied, ${targets.admin.assetsSkipped} up-to-date (${adminAssetCount} referenced)`
  );
  console.log(`  Removed: ${removedCount} stale files`);
  if (errorCount > 0) {
    console.log(`  Errors: ${errorCount}`);
  }
  console.log(`  Total: ${articles.length} files in index`);
}

// Only run when invoked directly (not when imported by tests)
if (process.argv[1] && process.argv[1].endsWith('bundle-help-content.ts')) {
  bundleHelpContent().catch(error => {
    console.error('Failed to bundle help content:', error);
    process.exit(1);
  });
}
