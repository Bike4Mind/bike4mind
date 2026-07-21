#!/usr/bin/env tsx
/**
 * Bundle Help Content Script
 *
 * Copies markdown files from docs-site/docs/ into apps/client/public/help-content/
 * for production serving. Uses real file copies (not symlinks) so content survives
 * Lambda deployment via OpenNext/SST.
 *
 * Only bundles files that are referenced in the help-index.json.
 *
 * Usage: pnpm --filter @bike4mind/scripts help:bundle-content
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { HelpIndex } from './types.js';
import { DEFAULT_LOCALE, discoverLocales, loadHelpArticles, localeContentRoot } from './loadHelpArticles.js';

// ES module compatibility
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Paths relative to project root
const DOCS_ROOT = path.resolve(__dirname, '../../../docs-site/docs');
const OUTPUT_DIR = path.resolve(__dirname, '../../../apps/client/public/help-content');
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

/** Running tallies threaded through the copy helper. */
interface BundleCounters {
  copied: number;
  skipped: number;
  errors: number;
}

/**
 * Copy one source markdown file to its bundle destination, recording the path in
 * `expectedFiles` (so cleanup won't reap it) and updating counters. Missing
 * sources and up-to-date destinations are handled without a rewrite.
 */
function bundleFile(
  sourcePath: string,
  destPath: string,
  label: string,
  expectedFiles: Set<string>,
  counters: BundleCounters
): void {
  expectedFiles.add(destPath);

  const destDir = path.dirname(destPath);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  if (!fs.existsSync(sourcePath)) {
    console.error(`Source file not found: ${sourcePath}`);
    counters.errors++;
    return;
  }

  if (isUpToDate(destPath, sourcePath)) {
    counters.skipped++;
    return;
  }

  try {
    copyFile(sourcePath, destPath);
    counters.copied++;
    console.log(`  Copied: ${label}`);
  } catch (error) {
    console.error(`Error copying ${label}:`, error);
    counters.errors++;
  }
}

/**
 * Bundle translated markdown for one locale into `<OUTPUT_DIR>/<locale>/`.
 * Only files that (a) actually exist in the locale tree and (b) correspond to an
 * indexed English slug are copied; untranslated articles are intentionally NOT
 * duplicated here — the runtime falls back to the English path on a 404.
 */
async function bundleLocale(
  locale: string,
  indexedSlugs: Set<string>,
  expectedFiles: Set<string>,
  counters: BundleCounters
): Promise<number> {
  const root = localeContentRoot(locale);
  const articles = await loadHelpArticles(locale);
  let count = 0;
  for (const article of articles) {
    if (!article.frontmatter.title || !indexedSlugs.has(article.slug)) continue;
    const sourcePath = path.join(root, article.relativePath);
    const destPath = path.join(OUTPUT_DIR, locale, article.relativePath);
    bundleFile(sourcePath, destPath, `${locale}/${article.relativePath}`, expectedFiles, counters);
    count++;
  }
  return count;
}

/**
 * Main bundle function.
 *
 * English content is copied flat into OUTPUT_DIR (unchanged); each translated
 * locale is copied under `OUTPUT_DIR/<locale>/`. A single cleanup pass at the end
 * reaps anything not (re)written this run, across English and all locales.
 */
async function bundleHelpContent(): Promise<void> {
  console.log('Bundling help content (file copies)...');
  console.log(`Docs root: ${DOCS_ROOT}`);
  console.log(`Output dir: ${OUTPUT_DIR}`);
  console.log(`Index path: ${INDEX_PATH}`);

  // Read the help index to know which files to bundle
  if (!fs.existsSync(INDEX_PATH)) {
    console.error('Error: help-index.json not found. Run help:build-index first.');
    process.exit(1);
  }

  const indexContent = fs.readFileSync(INDEX_PATH, 'utf-8');
  const helpIndex: HelpIndex = JSON.parse(indexContent);

  // Get list of files to bundle from the index
  const filesToBundle = helpIndex.entries.map(entry => entry.filePath);
  const indexedSlugs = new Set(helpIndex.entries.map(entry => entry.slug));

  console.log(`Found ${filesToBundle.length} files in help index`);

  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Track what files should exist in output
  const expectedFiles = new Set<string>();
  const counters: BundleCounters = { copied: 0, skipped: 0, errors: 0 };

  // English: flat copy into OUTPUT_DIR (original layout, preserved for back-compat).
  for (const file of filesToBundle) {
    bundleFile(path.join(DOCS_ROOT, file), path.join(OUTPUT_DIR, file), file, expectedFiles, counters);
  }

  // Translated locales: copy under OUTPUT_DIR/<locale>/ (only what's actually translated).
  const locales = discoverLocales().filter(l => l !== DEFAULT_LOCALE);
  for (const locale of locales) {
    const n = await bundleLocale(locale, indexedSlugs, expectedFiles, counters);
    console.log(`  Locale ${locale}: ${n} translated files`);
  }

  // Clean up stale files (files/symlinks that exist but aren't in the index)
  let removedCount = 0;
  function cleanupDirectory(dir: string): void {
    if (!fs.existsSync(dir)) return;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        cleanupDirectory(fullPath);
        // Remove empty directories
        try {
          const remaining = fs.readdirSync(fullPath);
          if (remaining.length === 0) {
            fs.rmdirSync(fullPath);
          }
        } catch {
          // Directory might not exist or have permission issues
        }
      } else if (!expectedFiles.has(fullPath) && entry.name !== '.gitkeep') {
        fs.unlinkSync(fullPath);
        removedCount++;
        console.log(`  Removed stale: ${path.relative(OUTPUT_DIR, fullPath)}`);
      }
    }
  }

  cleanupDirectory(OUTPUT_DIR);

  console.log(`\nSummary:`);
  console.log(`  Copied: ${counters.copied} files`);
  console.log(`  Skipped: ${counters.skipped} (already up-to-date)`);
  console.log(`  Removed: ${removedCount} stale files`);
  if (counters.errors > 0) {
    console.log(`  Errors: ${counters.errors}`);
  }
  console.log(`  English: ${filesToBundle.length} in index; locales: ${locales.join(', ') || 'none'}`);
}

bundleHelpContent().catch(error => {
  console.error('Failed to bundle help content:', error);
  process.exit(1);
});
