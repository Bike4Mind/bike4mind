#!/usr/bin/env tsx
/**
 * Build Help Index Script
 *
 * Generates a JSON index of all help documentation from docs-site/docs/
 * for use in the in-app Help Panel.
 *
 * Usage: pnpm --filter @bike4mind/scripts help:build-index
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import type { HelpIndex, HelpIndexEntry, HelpCategory } from './types.js';
import { INCLUDED_CATEGORIES, loadHelpArticles, type LoadedHelpArticle } from './loadHelpArticles.js';

// ES module compatibility
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUTPUT_PATH = path.resolve(__dirname, '../../../apps/client/app/generated/help-index.json');

/**
 * Convert category path to display label
 */
function categoryToLabel(category: string): string {
  return category
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Convert a loaded article into a help index entry.
 * Returns null for articles without a title (excluded from the index).
 */
function articleToEntry(article: LoadedHelpArticle): HelpIndexEntry | null {
  const { frontmatter } = article;

  // Skip files without a title
  if (!frontmatter.title) {
    console.warn(`Skipping ${article.relativePath}: No title in frontmatter`);
    return null;
  }

  return {
    slug: article.slug,
    title: frontmatter.title,
    description: frontmatter.description || '',
    category: article.category,
    sidebarPosition: frontmatter.sidebar_position ?? 999,
    tags: frontmatter.tags || [],
    headings: article.headings,
    filePath: article.relativePath,
    accessLevel: article.accessLevel,
  };
}

/**
 * Build category tree from entries
 */
function buildCategoryTree(entries: HelpIndexEntry[]): HelpCategory[] {
  const categoryMap = new Map<string, HelpCategory>();

  // Group entries by category
  for (const entry of entries) {
    const categoryPath = entry.category;
    const parts = categoryPath.split('/');

    let currentPath = '';
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const parentPath = currentPath;
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      if (!categoryMap.has(currentPath)) {
        categoryMap.set(currentPath, {
          name: part,
          label: categoryToLabel(part),
          entries: [],
          subcategories: [],
          sidebarPosition: 999,
          accessLevel: entry.accessLevel,
        });

        // Link to parent
        if (parentPath && categoryMap.has(parentPath)) {
          const parent = categoryMap.get(parentPath)!;
          if (!parent.subcategories.find(s => s.name === part)) {
            parent.subcategories.push(categoryMap.get(currentPath)!);
          }
        }
      }
    }

    // Add entry to its category
    const category = categoryMap.get(categoryPath);
    if (category) {
      category.entries.push(entry);
      // Use the lowest sidebar position as the category position
      if (entry.sidebarPosition < category.sidebarPosition) {
        category.sidebarPosition = entry.sidebarPosition;
      }
    }
  }

  // Get root categories (no parent)
  const rootCategories: HelpCategory[] = [];
  for (const [path, category] of categoryMap) {
    if (!path.includes('/')) {
      rootCategories.push(category);
    }
  }

  const sortCategories = (categories: HelpCategory[]): void => {
    categories.sort((a, b) => a.sidebarPosition - b.sidebarPosition || compareStrings(a.name, b.name));
    for (const cat of categories) {
      cat.entries.sort(compareEntries);
      sortCategories(cat.subcategories);
    }
  };

  sortCategories(rootCategories);

  return rootCategories;
}

/**
 * Locale-independent string comparator. `localeCompare` orders by ICU collation, which
 * varies by locale (and can reorder e.g. punctuation or case differently across
 * machines) - the opposite of what a reproducible-build tie-break needs. Plain
 * relational comparison orders by UTF-16 code unit, which is the same everywhere.
 */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Total order on entries within a category: sidebar position, then slug depth, then slug.
 *
 * The tie-breaks are what keep a regeneration diff meaningful. `sidebarPosition` is far
 * from unique - Docusaurus scopes `sidebar_position` per directory, while this index
 * flattens all of `features/**` into one category, so seven articles share position 1 -
 * and without a tie-break the order fell through to glob traversal: stable on one
 * machine, different on the next, so the list flipped every time a different contributor
 * regenerated. That is not cosmetic; HelpPanel renders the first five entries per
 * category as its featured list.
 *
 * Depth precedes slug so a nested article cannot displace a top-level one it merely
 * shares a number with (slug alone ranks `features/integrations/*` above
 * `features/overview`, pushing the landing article off the featured list).
 */
export function compareEntries(a: HelpIndexEntry, b: HelpIndexEntry): number {
  return (
    a.sidebarPosition - b.sidebarPosition ||
    a.slug.split('/').length - b.slug.split('/').length ||
    compareStrings(a.slug, b.slug)
  );
}

/**
 * Derive `version` from the entries themselves rather than the wall clock, so a
 * regen with no corpus changes produces byte-identical output (the `/api/help`
 * ETag in apps/client/pages/api/help/index.ts keys off this value, and a clock
 * timestamp made it - and the whole file - diff on every single build).
 */
export function computeVersion(entries: HelpIndexEntry[]): string {
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 16);
}

/** Sort entries and derive categories/version from them - the pure, testable core of the build. */
export function buildIndexFromEntries(rawEntries: HelpIndexEntry[]): HelpIndex {
  const entries = [...rawEntries].sort((a, b) => compareStrings(a.category, b.category) || compareEntries(a, b));
  const categories = buildCategoryTree(entries);
  return {
    entries,
    categories,
    version: computeVersion(entries),
  };
}

/**
 * Main build function
 */
async function buildHelpIndex(): Promise<void> {
  console.log('Building help index...');
  console.log(`Output path: ${OUTPUT_PATH}`);
  console.log(`Including categories: ${INCLUDED_CATEGORIES.join(', ')}`);

  // Load all user-facing help articles (shared loader owns file selection + parsing)
  const articles = await loadHelpArticles();
  console.log(`Found ${articles.length} markdown files in user-facing categories`);

  // Convert to index entries, skipping title-less files
  const entries: HelpIndexEntry[] = [];
  for (const article of articles) {
    const entry = articleToEntry(article);
    if (entry) {
      entries.push(entry);
    }
  }

  console.log(`Processed ${entries.length} valid entries`);

  const index = buildIndexFromEntries(entries);
  const { categories } = index;

  // Ensure output directory exists
  const outputDir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Write the index
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(index, null, 2));

  console.log(`Help index written to ${OUTPUT_PATH}`);
  console.log(`Total entries: ${entries.length}`);
  console.log(`Categories: ${categories.map(c => c.name).join(', ')}`);
}

// Only run when invoked directly (not when imported by tests)
if (process.argv[1] && process.argv[1].endsWith('build-help-index.ts')) {
  buildHelpIndex().catch(error => {
    console.error('Failed to build help index:', error);
    process.exit(1);
  });
}
