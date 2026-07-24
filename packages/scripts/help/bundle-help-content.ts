#!/usr/bin/env tsx
/**
 * Bundle Help Content Script
 *
 * Copies markdown files from docs-site/docs/ into apps/client/public/help-content/
 * for production serving. Uses real file copies (not symlinks) so content survives
 * Lambda deployment via OpenNext/SST.
 *
 * Only bundles files that are referenced in the help-index.json, plus any media
 * assets (images, GIFs, demo videos) those articles reference - copied with the
 * same docs-root-relative path so relative references resolve under
 * /help-content/ at runtime. Existence, format, and size rules for that media
 * are enforced by validate-help-content.ts, not here.
 *
 * Usage: pnpm --filter @bike4mind/scripts help:bundle-content
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { HelpIndex } from './types.js';
import { extractMarkdownLinks, hasAssetExtension, isExternal, resolveAssetPath } from './validate-help-content.js';

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

export interface BundleOptions {
  /** Overridable roots for testing; default to the real repo locations. */
  docsRoot?: string;
  outputDir?: string;
  indexPath?: string;
}

/**
 * Main bundle function
 */
export async function bundleHelpContent(opts: BundleOptions = {}): Promise<void> {
  const docsRoot = opts.docsRoot ?? DOCS_ROOT;
  const outputDir = opts.outputDir ?? OUTPUT_DIR;
  const indexPath = opts.indexPath ?? INDEX_PATH;

  console.log('Bundling help content (file copies)...');
  console.log(`Docs root: ${docsRoot}`);
  console.log(`Output dir: ${outputDir}`);
  console.log(`Index path: ${indexPath}`);

  // Read the help index to know which files to bundle
  if (!fs.existsSync(indexPath)) {
    throw new Error('help-index.json not found. Run help:build-index first.');
  }

  const indexContent = fs.readFileSync(indexPath, 'utf-8');
  const helpIndex: HelpIndex = JSON.parse(indexContent);

  // Get list of files to bundle from the index
  const filesToBundle = helpIndex.entries.map(entry => entry.filePath);

  console.log(`Found ${filesToBundle.length} files in help index`);

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Track what files should exist in output
  const expectedFiles = new Set<string>();
  let copiedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const file of filesToBundle) {
    const sourcePath = path.join(docsRoot, file);
    const destPath = path.join(outputDir, file);
    expectedFiles.add(destPath);

    // Ensure destination directory exists
    const destDir = path.dirname(destPath);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    // Check if source file exists
    if (!fs.existsSync(sourcePath)) {
      console.error(`Source file not found: ${sourcePath}`);
      errorCount++;
      continue;
    }

    // Check if dest is already an up-to-date copy
    if (isUpToDate(destPath, sourcePath)) {
      skippedCount++;
      continue;
    }

    try {
      copyFile(sourcePath, destPath);
      copiedCount++;
      console.log(`  Copied: ${file}`);
    } catch (error) {
      console.error(`Error copying ${file}:`, error);
      errorCount++;
    }
  }

  // Collect media/assets referenced by the bundled articles. Broken or escaping
  // references are skipped silently here - the validator reports them as errors.
  const assetRelPaths = new Set<string>();
  for (const file of filesToBundle) {
    const sourcePath = path.join(docsRoot, file);
    if (!fs.existsSync(sourcePath)) continue;
    const content = fs.readFileSync(sourcePath, 'utf-8');
    for (const link of extractMarkdownLinks(content)) {
      const pathPart = link.target.split('#')[0];
      if (!pathPart || isExternal(pathPart)) continue;
      if (!link.isImage && !hasAssetExtension(pathPart)) continue;
      const absSource = resolveAssetPath(pathPart, path.dirname(sourcePath), docsRoot);
      if (!absSource || !fs.existsSync(absSource)) continue;
      assetRelPaths.add(path.relative(docsRoot, absSource));
    }
  }

  let assetCopiedCount = 0;
  let assetSkippedCount = 0;
  for (const relPath of assetRelPaths) {
    const sourcePath = path.join(docsRoot, relPath);
    const destPath = path.join(outputDir, relPath);
    expectedFiles.add(destPath);

    const destDir = path.dirname(destPath);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    if (isUpToDate(destPath, sourcePath)) {
      assetSkippedCount++;
      continue;
    }

    try {
      copyFile(sourcePath, destPath);
      assetCopiedCount++;
      console.log(`  Copied asset: ${relPath}`);
    } catch (error) {
      console.error(`Error copying asset ${relPath}:`, error);
      errorCount++;
    }
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
        console.log(`  Removed stale: ${path.relative(outputDir, fullPath)}`);
      }
    }
  }

  cleanupDirectory(outputDir);

  console.log(`\nSummary:`);
  console.log(`  Copied: ${copiedCount} files`);
  console.log(`  Skipped: ${skippedCount} (already up-to-date)`);
  console.log(
    `  Assets: ${assetCopiedCount} copied, ${assetSkippedCount} up-to-date (${assetRelPaths.size} referenced)`
  );
  console.log(`  Removed: ${removedCount} stale files`);
  if (errorCount > 0) {
    console.log(`  Errors: ${errorCount}`);
  }
  console.log(`  Total: ${filesToBundle.length} files in index`);
}

// Only run when invoked directly (not when imported by tests)
if (process.argv[1] && process.argv[1].endsWith('bundle-help-content.ts')) {
  bundleHelpContent().catch(error => {
    console.error('Failed to bundle help content:', error);
    process.exit(1);
  });
}
