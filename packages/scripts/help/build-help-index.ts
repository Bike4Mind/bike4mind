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
import { fileURLToPath } from 'url';
import type { HelpIndex, HelpIndexEntry, HelpCategory } from './types.js';
import {
  INCLUDED_CATEGORIES,
  DEFAULT_LOCALE,
  discoverLocales,
  loadHelpArticles,
  type LoadedHelpArticle,
} from './loadHelpArticles.js';

// ES module compatibility
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUTPUT_DIR = path.resolve(__dirname, '../../../apps/client/app/generated');
const OUTPUT_PATH = path.join(OUTPUT_DIR, 'help-index.json');

/** Output path for a locale's index. English uses the unsuffixed `help-index.json`. */
function localeIndexPath(locale: string): string {
  return locale === DEFAULT_LOCALE ? OUTPUT_PATH : path.join(OUTPUT_DIR, `help-index.${locale}.json`);
}

/**
 * Produce a locale's entry list by overlaying its translated entries onto the
 * full English set: an English entry is replaced by its translation when one
 * exists (matched by slug), and kept as-is otherwise. This guarantees every
 * locale index covers the same slugs as English — untranslated articles fall
 * back to English rather than vanishing from the index.
 */
export function applyLocaleFallback(enEntries: HelpIndexEntry[], localeEntries: HelpIndexEntry[]): HelpIndexEntry[] {
  const bySlug = new Map(localeEntries.map(e => [e.slug, e]));
  return enEntries.map(e => bySlug.get(e.slug) ?? e);
}

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

  // Sort categories and their entries
  const sortCategories = (categories: HelpCategory[]): void => {
    categories.sort((a, b) => a.sidebarPosition - b.sidebarPosition);
    for (const cat of categories) {
      cat.entries.sort((a, b) => a.sidebarPosition - b.sidebarPosition);
      sortCategories(cat.subcategories);
    }
  };

  sortCategories(rootCategories);

  return rootCategories;
}

/** Convert loaded articles into sorted index entries, dropping title-less files. */
function entriesFromArticles(articles: LoadedHelpArticle[]): HelpIndexEntry[] {
  const entries: HelpIndexEntry[] = [];
  for (const article of articles) {
    const entry = articleToEntry(article);
    if (entry) entries.push(entry);
  }

  entries.sort((a, b) => {
    if (a.category !== b.category) {
      return a.category.localeCompare(b.category);
    }
    return a.sidebarPosition - b.sidebarPosition;
  });

  return entries;
}

/** Assemble a full HelpIndex from entries, sharing a single build version across locales. */
function assembleIndex(entries: HelpIndexEntry[], version: string): HelpIndex {
  return { entries, categories: buildCategoryTree(entries), version };
}

/**
 * Main build function.
 *
 * Emits `help-index.json` (English) plus `help-index.<locale>.json` for every
 * translated locale present under I18N_ROOT. Locale indexes fall back to English
 * per-article so their slug coverage always matches English. All indexes share
 * one `version` string so role/locale-aware ETags stay coherent within a build.
 */
async function buildHelpIndex(): Promise<void> {
  console.log('Building help index...');
  console.log(`Output dir: ${OUTPUT_DIR}`);
  console.log(`Including categories: ${INCLUDED_CATEGORIES.join(', ')}`);

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const version = new Date().toISOString();

  // English is the canonical, complete set every locale falls back to.
  const enArticles = await loadHelpArticles(DEFAULT_LOCALE);
  const enEntries = entriesFromArticles(enArticles);
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(assembleIndex(enEntries, version), null, 2));
  console.log(`[en] ${enEntries.length} entries -> ${path.basename(OUTPUT_PATH)}`);

  const locales = discoverLocales().filter(l => l !== DEFAULT_LOCALE);
  for (const locale of locales) {
    const localeEntries = entriesFromArticles(await loadHelpArticles(locale));
    const merged = applyLocaleFallback(enEntries, localeEntries);
    const translated = localeEntries.length;
    const outPath = localeIndexPath(locale);
    fs.writeFileSync(outPath, JSON.stringify(assembleIndex(merged, version), null, 2));
    console.log(
      `[${locale}] ${translated} translated, ${merged.length - translated} English fallback -> ${path.basename(outPath)}`
    );
  }

  console.log(`Done. Locales: ${[DEFAULT_LOCALE, ...locales].join(', ')}`);
}

// Run only when invoked directly, so tests can import the pure helpers (e.g.
// applyLocaleFallback) without triggering a real index build.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildHelpIndex().catch(error => {
    console.error('Failed to build help index:', error);
    process.exit(1);
  });
}
