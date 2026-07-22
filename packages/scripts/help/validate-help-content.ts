#!/usr/bin/env tsx
/**
 * Validate Help Content Script
 *
 * Validates the user-facing help corpus (docs-site/docs/{features,admin}) for:
 * - Frontmatter:   required `title` and `description`; well-typed `sidebar_position`/`tags`.
 * - Internal links: every `[...](*.md)` link resolves to a real article file on disk.
 * - Anchor links:  every `#anchor` (same-page) and `file.md#anchor` link points to a real heading.
 * - Images/assets: every `![...](path)` references a file that exists on disk.
 * - Media guards:  embedded media must live inside the docs tree (no external
 *   hosts, no path traversal), use web-playable formats (.webm/.mp4 for video),
 *   and stay under the MEDIA_SIZE_LIMITS caps - everything under
 *   public/help-content ships in the deploy bundle and is downloaded by users.
 *
 * Relative links reuse the SAME `./` / `../` algorithm as the in-app renderer
 * (`resolveRelativePath` from utils.ts), but resolve against the article's FILE path
 * rather than its slug so that links from/to index pages resolve correctly.
 *
 * Exits non-zero when any error-level finding is present, so it can gate CI / pre-commit.
 *
 * Usage: pnpm --filter @bike4mind/scripts help:validate
 */

import * as fs from 'fs';
import * as path from 'path';
import { DOCS_ROOT, loadHelpArticles, type LoadedHelpArticle } from './loadHelpArticles.js';
import { resolveRelativePath, stripMarkdownFormatting, toAnchor, VIDEO_EXTENSIONS } from './utils.js';

export type FindingType = 'frontmatter' | 'link' | 'anchor' | 'image' | 'media';

export interface Finding {
  type: FindingType;
  /** Article slug the finding belongs to. */
  slug: string;
  /** Relative file path (for display). */
  file: string;
  /** 1-based line number, when known. */
  line?: number;
  message: string;
}

export interface ExtractedLink {
  /** Raw link target as written (path plus optional #anchor, first token only). */
  target: string;
  /** True for image links (`![...]`). */
  isImage: boolean;
  /** 1-based line number in the original content. */
  line: number;
}

const EXTERNAL_PREFIXES = ['http://', 'https://', 'mailto:', 'tel:', '//'];
const ASSET_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.pdf', ...VIDEO_EXTENSIONS];

/**
 * Size caps (bytes) for embedded help media. Bundled media ships in the deploy
 * bundle and is downloaded by end users, so an oversized file is an error, not
 * a warning. GIFs get a slightly higher cap than stills but anything longer
 * than a few seconds should be a muted .webm clip instead (10-20x smaller).
 */
export const MEDIA_SIZE_LIMITS: Record<string, { extensions: string[]; maxBytes: number }> = {
  image: { extensions: ['.png', '.jpg', '.jpeg', '.svg', '.webp', '.ico'], maxBytes: 1 * 1024 * 1024 },
  gif: { extensions: ['.gif'], maxBytes: 3 * 1024 * 1024 },
  video: { extensions: VIDEO_EXTENSIONS, maxBytes: 10 * 1024 * 1024 },
};

/** Video containers browsers can't reliably play inline - rejected with guidance. */
const UNSUPPORTED_MEDIA_EXTENSIONS = ['.mov', '.avi', '.mkv', '.m4v', '.wmv', '.flv', '.ogv'];

/**
 * Blank out fenced code blocks, inline code spans, and HTML comments while
 * preserving newlines (and therefore line numbers). This prevents example
 * markdown inside code samples from being mistaken for real links.
 */
export function stripCodeSpans(content: string): string {
  const blankKeepingNewlines = (match: string): string => match.replace(/[^\n]/g, ' ');
  return content
    .replace(/```[\s\S]*?```/g, blankKeepingNewlines) // fenced ```
    .replace(/~~~[\s\S]*?~~~/g, blankKeepingNewlines) // fenced ~~~
    .replace(/<!--[\s\S]*?-->/g, blankKeepingNewlines) // HTML comments
    .replace(/`[^`\n]*`/g, blankKeepingNewlines); // inline code
}

/** Compute the 1-based line number for a character offset. */
function lineAt(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

/**
 * Extract every markdown link and image target from content, ignoring anything
 * inside code spans. Only the first whitespace-delimited token of the target is
 * returned (drops optional `"title"` suffixes).
 */
export function extractMarkdownLinks(content: string): ExtractedLink[] {
  const cleaned = stripCodeSpans(content);
  const links: ExtractedLink[] = [];
  // (!?)  -> image marker; \[[^\]]*\] -> [text]; \(([^)]+)\) -> (target)
  const linkRegex = /(!?)\[[^\]]*\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(cleaned)) !== null) {
    const isImage = match[1] === '!';
    const rawTarget = match[2].trim();
    // Drop an optional title: (path "Title") / (path 'Title')
    const target = rawTarget.split(/\s+/)[0];
    if (!target) continue;
    links.push({ target, isImage, line: lineAt(cleaned, match.index) });
  }

  return links;
}

/**
 * Compute the set of valid anchor ids for an article, honoring Docusaurus
 * explicit heading ids (`## Title {#custom-id}`) in addition to the auto-generated
 * `toAnchor` slug used by the in-app renderer.
 */
export function getArticleAnchors(content: string): Set<string> {
  const anchors = new Set<string>();
  const headingRegex = /^(#{1,6})\s+(.+)$/gm;
  let match: RegExpExecArray | null;

  while ((match = headingRegex.exec(content)) !== null) {
    let text = match[2].trim();

    // Explicit id: `## Heading {#custom-id}`
    const idMatch = text.match(/\{#([^}]+)\}\s*$/);
    if (idMatch) {
      anchors.add(idMatch[1]);
      text = text.replace(/\{#[^}]+\}\s*$/, '').trim();
    }

    // Auto-generated anchor (matches HelpContent.tsx heading id generation)
    const auto = toAnchor(stripMarkdownFormatting(text));
    if (auto) anchors.add(auto);
  }

  return anchors;
}

export function isExternal(target: string): boolean {
  const lower = target.toLowerCase();
  return EXTERNAL_PREFIXES.some(p => lower.startsWith(p));
}

export function hasAssetExtension(pathPart: string): boolean {
  const lower = pathPart.toLowerCase();
  return ASSET_EXTENSIONS.some(ext => lower.endsWith(ext));
}

/**
 * Resolve an asset link target to an absolute path, or null when the resolved
 * path escapes the docs tree (path traversal). Shared with
 * bundle-help-content.ts so validation and bundling agree on where an asset
 * lives on disk.
 */
export function resolveAssetPath(pathPart: string, articleDir: string, docsRoot: string): string | null {
  const abs = pathPart.startsWith('/') ? path.join(docsRoot, pathPart) : path.resolve(articleDir, pathPart);
  const rel = path.relative(docsRoot, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return abs;
}

function mediaSizeLimit(pathPart: string): { kind: string; maxBytes: number } | null {
  const lower = pathPart.toLowerCase();
  for (const [kind, limit] of Object.entries(MEDIA_SIZE_LIMITS)) {
    if (limit.extensions.some(ext => lower.endsWith(ext))) return { kind, maxBytes: limit.maxBytes };
  }
  return null;
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Normalize a resolved path to a canonical article slug, mirroring
 * `filePathToSlug`: a trailing `/index` collapses to its parent directory and a
 * bare `index` collapses to the root. This lets links to `./index.md` resolve to
 * the index article's real slug.
 */
function normalizeSlug(slug: string): string {
  if (slug.endsWith('/index')) return slug.replace(/\/index$/, '');
  if (slug === 'index') return '';
  return slug;
}

/** Split a link target into its path portion and optional anchor. */
function splitAnchor(target: string): { pathPart: string; anchor: string | null } {
  const hashIndex = target.indexOf('#');
  if (hashIndex === -1) return { pathPart: target, anchor: null };
  return {
    pathPart: target.substring(0, hashIndex),
    anchor: target.substring(hashIndex + 1),
  };
}

/**
 * Validate frontmatter for a single article.
 */
export function validateFrontmatter(article: LoadedHelpArticle): Finding[] {
  const findings: Finding[] = [];
  const base = { slug: article.slug, file: article.relativePath };
  const fm = article.frontmatter;

  if (!fm.title || String(fm.title).trim() === '') {
    findings.push({ ...base, type: 'frontmatter', message: 'Missing required frontmatter field: title' });
  }
  if (!fm.description || String(fm.description).trim() === '') {
    findings.push({ ...base, type: 'frontmatter', message: 'Missing required frontmatter field: description' });
  }
  if (fm.sidebar_position !== undefined && typeof fm.sidebar_position !== 'number') {
    findings.push({
      ...base,
      type: 'frontmatter',
      message: `Frontmatter "sidebar_position" must be a number (got ${typeof fm.sidebar_position})`,
    });
  }
  if (fm.tags !== undefined && !Array.isArray(fm.tags)) {
    findings.push({ ...base, type: 'frontmatter', message: 'Frontmatter "tags" must be an array' });
  }

  return findings;
}

export interface ValidateOptions {
  /** Predicate for asset existence; injected for testing. Defaults to fs.existsSync. */
  fileExists?: (absPath: string) => boolean;
  /** Root for resolving absolute (`/foo.png`) asset paths. Defaults to DOCS_ROOT. */
  docsRoot?: string;
  /** Asset size lookup (bytes); injected for testing. Defaults to fs.statSync. */
  fileSize?: (absPath: string) => number | undefined;
}

/**
 * Validate a full set of loaded articles. Pure given the injected `fileExists`
 * predicate - returns all findings without touching process state.
 */
export function validateArticles(articles: LoadedHelpArticle[], opts: ValidateOptions = {}): Finding[] {
  const fileExists = opts.fileExists ?? ((p: string) => fs.existsSync(p));
  const docsRoot = opts.docsRoot ?? DOCS_ROOT;
  const fileSize =
    opts.fileSize ??
    ((p: string): number | undefined => {
      try {
        return fs.statSync(p).size;
      } catch {
        return undefined;
      }
    });

  const anchorsBySlug = new Map<string, Set<string>>();
  for (const a of articles) {
    anchorsBySlug.set(a.slug, getArticleAnchors(a.content));
  }

  const findings: Finding[] = [];

  for (const article of articles) {
    findings.push(...validateFrontmatter(article));

    const base = { slug: article.slug, file: article.relativePath };
    const ownAnchors = anchorsBySlug.get(article.slug)!;
    const articleDir = path.dirname(article.filePath);
    // Resolve relative links against the article's FILE path (not its slug):
    // an index page's slug drops the "/index" segment, so slug-based resolution
    // would compute the wrong base directory for its relative links.
    const fileBase = article.relativePath.replace(/\.md$/, '');

    for (const link of extractMarkdownLinks(article.content)) {
      const { pathPart, anchor } = splitAnchor(link.target);

      // Pure same-page anchor: #section
      if (pathPart === '' && anchor !== null) {
        if (!ownAnchors.has(anchor)) {
          findings.push({
            ...base,
            type: 'anchor',
            line: link.line,
            message: `Anchor "#${anchor}" does not match any heading in this article`,
          });
        }
        continue;
      }

      if (isExternal(link.target)) {
        // Media must be committed to the docs tree so it ships on the app CDN
        // (deterministic performance, no third-party hosts in the Help Center).
        if (link.isImage || hasAssetExtension(pathPart)) {
          findings.push({
            ...base,
            type: 'media',
            line: link.line,
            message: `External media is not allowed: "${link.target}". Commit the file next to the article (e.g. ./media/) so it ships on the app CDN`,
          });
        }
        continue;
      }

      // Web-unplayable video containers are rejected up front - otherwise a
      // [link](demo.mov) would fall through to article-link resolution and
      // produce a confusing "broken link" error.
      const unsupported = UNSUPPORTED_MEDIA_EXTENSIONS.find(ext => pathPart.toLowerCase().endsWith(ext));
      if (unsupported) {
        findings.push({
          ...base,
          type: 'media',
          line: link.line,
          message: `Unsupported media format "${unsupported}" in "${pathPart}": convert to ${VIDEO_EXTENSIONS.join(' or ')} for inline playback`,
        });
        continue;
      }

      // Image / asset reference: resolve on disk
      if (link.isImage || hasAssetExtension(pathPart)) {
        const absPath = resolveAssetPath(pathPart, articleDir, docsRoot);
        if (!absPath) {
          findings.push({
            ...base,
            type: 'media',
            line: link.line,
            message: `Asset path escapes the docs tree: ${pathPart}`,
          });
          continue;
        }
        if (!fileExists(absPath)) {
          findings.push({
            ...base,
            type: 'image',
            line: link.line,
            message: `Referenced asset not found: ${pathPart}`,
          });
          continue;
        }
        const limit = mediaSizeLimit(pathPart);
        const size = limit ? fileSize(absPath) : undefined;
        if (limit && size !== undefined && size > limit.maxBytes) {
          findings.push({
            ...base,
            type: 'media',
            line: link.line,
            message: `${limit.kind} "${pathPart}" is ${formatMb(size)}, over the ${formatMb(limit.maxBytes)} ${limit.kind} cap. Shorten it or re-encode (long GIFs should be muted .webm clips)`,
          });
        }
        continue;
      }

      // Internal document link. Absolute (`/...`, optionally with the Docusaurus
      // `/docs/` baseUrl) is a site-relative path; relative (`./`, `../`, bare)
      // resolves against this article's file directory (reusing the same
      // algorithm the in-app renderer uses).
      const resolvedPath = pathPart.startsWith('/')
        ? pathPart.replace(/^\/(docs\/)?/, '').replace(/\.md$/, '')
        : resolveRelativePath(fileBase, pathPart);

      // "Resolves to an actual article" = a real markdown file exists on disk
      // (either <path>.md or <path>/index.md). This treats dual-published docs
      // outside the served help categories as valid link targets.
      const fileCandidates = [path.join(docsRoot, `${resolvedPath}.md`), path.join(docsRoot, resolvedPath, 'index.md')];
      if (!fileCandidates.some(fileExists)) {
        findings.push({
          ...base,
          type: 'link',
          line: link.line,
          message: `Broken internal link: "${link.target}" resolves to missing article "${resolvedPath}"`,
        });
        continue;
      }

      // Cross-article anchor: file.md#section. Only validated when the target is
      // a loaded help article (non-help docs aren't parsed for headings).
      if (anchor) {
        const targetAnchors = anchorsBySlug.get(normalizeSlug(resolvedPath));
        if (targetAnchors && !targetAnchors.has(anchor)) {
          findings.push({
            ...base,
            type: 'anchor',
            line: link.line,
            message: `Anchor "#${anchor}" not found in target article "${normalizeSlug(resolvedPath)}"`,
          });
        }
      }
    }
  }

  return findings;
}

/** Format findings grouped by file for human-readable output. */
export function formatFindings(findings: Finding[]): string {
  if (findings.length === 0) return '';
  const byFile = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = byFile.get(f.file) ?? [];
    list.push(f);
    byFile.set(f.file, list);
  }
  const lines: string[] = [];
  for (const [file, list] of byFile) {
    lines.push(`\n  ${file}`);
    for (const f of list) {
      const loc = f.line ? `:${f.line}` : '';
      lines.push(`    [${f.type}]${loc} ${f.message}`);
    }
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  console.log('Validating help content...');
  const articles = await loadHelpArticles();
  console.log(`Loaded ${articles.length} help articles from ${DOCS_ROOT}`);

  const findings = validateArticles(articles);

  if (findings.length === 0) {
    console.log('✅ Help content validation passed — no broken links, anchors, media, or frontmatter issues.');
    return;
  }

  const counts = findings.reduce<Record<string, number>>((acc, f) => {
    acc[f.type] = (acc[f.type] ?? 0) + 1;
    return acc;
  }, {});

  console.error(`\n❌ Help content validation found ${findings.length} issue(s):`);
  console.error(
    `   ` +
      (['frontmatter', 'link', 'anchor', 'image', 'media'] as FindingType[])
        .filter(t => counts[t])
        .map(t => `${counts[t]} ${t}`)
        .join(', ')
  );
  console.error(formatFindings(findings));
  console.error('');
  process.exit(1);
}

// Only run when invoked directly (not when imported by tests)
if (process.argv[1] && process.argv[1].endsWith('validate-help-content.ts')) {
  main().catch(error => {
    console.error('Failed to validate help content:', error);
    process.exit(1);
  });
}
