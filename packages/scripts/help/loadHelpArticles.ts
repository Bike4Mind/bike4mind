/**
 * Shared help-article loader.
 *
 * Single source of truth for WHICH markdown files count as help content and HOW
 * they are parsed. Consumed by:
 * - build-help-index.ts    - turns articles into the runtime help-index.json
 * - validate-help-content.ts - validates links/images/anchors/frontmatter
 *
 * Keeping the file selection (categories, exclusions) and parsing (slug, category,
 * headings) in one place ensures the validator and the index never disagree about
 * what the help corpus is.
 */

import { glob } from 'glob';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import matter from 'gray-matter';
import type { HelpHeading, HelpFrontmatter, HelpAccessLevel } from './types.js';
import { stripMarkdownFormatting, toAnchor } from './utils.js';

// ES module compatibility
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Absolute path to the docs-site content root (canonical English source). */
export const DOCS_ROOT = path.resolve(__dirname, '../../../docs-site/docs');

/**
 * Root for translated content trees. Each locale mirrors the English category
 * layout, e.g. `docs-site/i18n/es/features/notebooks.md`. English is NEVER
 * duplicated here — it lives in DOCS_ROOT and is the fallback for any article a
 * locale hasn't translated. Populated by the `help:translate` script.
 */
export const I18N_ROOT = path.resolve(__dirname, '../../../docs-site/i18n');

/** The canonical source locale. Its content lives at DOCS_ROOT, not under I18N_ROOT. */
export const DEFAULT_LOCALE = 'en';

/** Resolve the content root for a locale: DOCS_ROOT for English, else the i18n overlay. */
export function localeContentRoot(locale: string): string {
  return locale === DEFAULT_LOCALE ? DOCS_ROOT : path.join(I18N_ROOT, locale);
}

/**
 * Locales that have content on disk, always starting with English. A locale
 * counts as present once its directory exists under I18N_ROOT (created by
 * `help:translate`). With no i18n tree, this returns just `['en']`, so the whole
 * pipeline degrades to the original single-locale behavior.
 */
export function discoverLocales(): string[] {
  const locales = [DEFAULT_LOCALE];
  try {
    for (const entry of fs.readdirSync(I18N_ROOT, { withFileTypes: true })) {
      if (entry.isDirectory()) locales.push(entry.name);
    }
  } catch {
    // No i18n tree yet — English only.
  }
  return locales;
}

/**
 * Categories to include as user-facing help content.
 * Technical docs, API docs, deployment, etc. are excluded.
 */
export const INCLUDED_CATEGORIES = ['features', 'admin'];

/** Maps each included category to its access level for runtime filtering. */
export const CATEGORY_ACCESS_LEVELS: Record<string, HelpAccessLevel> = {
  features: 'public',
  admin: 'admin',
};

/**
 * Directories (relative to a category root) to exclude wholesale.
 * `quest-examples` holds generated example quest logs with no frontmatter - they
 * are not user-facing help and never appear in the served index.
 */
export const EXCLUDED_DIRS = ['quest-examples'];

/** Files to exclude even within included categories. */
export const EXCLUDED_FILES = [
  'master-documentation-plan.md',
  'to-do.md',
  'system-secrets-management.md',
  'research-mode-implementation.md',
  'notebook-splash-design.md',
  'notebook-import-export.md',
  'gamedev-powered-roadmap.md',
  'artifacts-system-roadmap.md',
  'feature-flags.md',
  'questmaster-export.md',
  'accounts.md',
];

/** A parsed help article, before any consumer-specific shaping. */
export interface LoadedHelpArticle {
  /** Absolute path on disk. */
  filePath: string;
  /** Path relative to DOCS_ROOT (e.g. "features/notebooks.md"). */
  relativePath: string;
  /** URL slug (e.g. "features/notebooks"); "" for a root index. */
  slug: string;
  /** Category directory (e.g. "features" or "features/sub"). */
  category: string;
  /** Access level derived from the top-level category. */
  accessLevel: HelpAccessLevel;
  /** Parsed frontmatter. */
  frontmatter: HelpFrontmatter;
  /** Markdown body with frontmatter stripped. */
  content: string;
  /** Headings extracted from the body, with canonical anchors. */
  headings: HelpHeading[];
}

/** Extract headings from markdown content, computing canonical anchors. */
export function extractHeadings(content: string): HelpHeading[] {
  const headingRegex = /^(#{1,6})\s+(.+)$/gm;
  const headings: HelpHeading[] = [];
  let match;

  while ((match = headingRegex.exec(content)) !== null) {
    const level = match[1].length;
    const rawText = match[2].trim();
    // Strip markdown formatting for clean display text
    const text = stripMarkdownFormatting(rawText);
    headings.push({
      level,
      text,
      anchor: toAnchor(text),
    });
  }

  return headings;
}

/**
 * Generate a slug from an absolute file path (mirrors runtime routing). `root`
 * defaults to the English source; pass a locale root so a translated file yields
 * the SAME slug as its English original.
 */
export function filePathToSlug(filePath: string, root: string = DOCS_ROOT): string {
  const relativePath = path.relative(root, filePath);
  let slug = relativePath.replace(/\.md$/, '');

  // Remove index from the slug (e.g., "features/index" -> "features")
  if (slug.endsWith('/index')) {
    slug = slug.replace(/\/index$/, '');
  } else if (slug === 'index') {
    slug = '';
  }

  // Normalize Windows separators to URL separators
  return slug.replace(/\\/g, '/');
}

/** Get the category (first directory) from an absolute file path, relative to `root`. */
export function getCategory(filePath: string, root: string = DOCS_ROOT): string {
  const relativePath = path.relative(root, filePath);
  const parts = relativePath.split(path.sep);

  // Return the first directory, or 'root' for top-level files
  if (parts.length > 1) {
    return parts[0];
  }
  return 'root';
}

/**
 * Find all help-article file paths (absolute), applying category inclusion and
 * file exclusion. Preserves glob traversal order (per-category), which the index
 * builder relies on as the stable tie-break for equal sidebar positions.
 */
export async function findHelpArticleFiles(root: string = DOCS_ROOT): Promise<string[]> {
  const categoryPatterns = INCLUDED_CATEGORIES.map(cat => `${cat}/**/*.md`);

  const files: string[] = [];
  for (const pattern of categoryPatterns) {
    const categoryFiles = await glob(pattern, {
      cwd: root,
      absolute: true,
      ignore: ['**/node_modules/**'],
    });
    files.push(...categoryFiles);
  }

  return files.filter(file => {
    if (EXCLUDED_FILES.includes(path.basename(file))) return false;
    const segments = path.relative(root, file).split(path.sep);
    return !segments.some(seg => EXCLUDED_DIRS.includes(seg));
  });
}

/**
 * Load and parse every help article. Unlike the index builder, this does NOT
 * skip articles missing a title - that check is left to consumers (the validator
 * reports it as an error; the index builder skips it).
 */
export async function loadHelpArticles(locale: string = DEFAULT_LOCALE): Promise<LoadedHelpArticle[]> {
  const root = localeContentRoot(locale);
  const files = await findHelpArticleFiles(root);
  const articles: LoadedHelpArticle[] = [];

  for (const filePath of files) {
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const { data: frontmatter, content } = matter(fileContent) as {
      data: HelpFrontmatter;
      content: string;
    };

    const category = getCategory(filePath, root);
    const topCategory = category.split('/')[0];

    articles.push({
      filePath,
      // relativePath stays locale-agnostic (e.g. "features/notebooks.md") so an
      // article and its translations share it — consumers key off it directly.
      relativePath: path.relative(root, filePath),
      slug: filePathToSlug(filePath, root),
      category,
      accessLevel: CATEGORY_ACCESS_LEVELS[topCategory] ?? 'public',
      frontmatter,
      content,
      headings: extractHeadings(content),
    });
  }

  return articles;
}
