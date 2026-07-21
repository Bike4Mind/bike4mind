#!/usr/bin/env tsx
/**
 * Translate Help Content Script
 *
 * Machine-translates the canonical English help corpus (docs-site/docs) into one
 * or more locale trees under docs-site/i18n/<locale>/, mirroring the category
 * layout so each translated file shares its English original's slug. The rest of
 * the help pipeline (build-index, bundle-content) then picks these up
 * automatically, with per-article English fallback for anything untranslated.
 *
 * This mirrors syncTranslations.ts (the UI-string translator): the model + API
 * keys are the DB-configured "operations model" resolved via OperationsModelService,
 * so run it under `sst shell` against a stage. There is NO human review step here,
 * exactly as with the 25 existing UI-string locales — the operations LLM is the
 * source of the translation, and that quality bar is accepted.
 *
 * Usage (run against a stage so Resource.MONGODB_URI + system keys resolve):
 *   ./for-env dev pnpm sst shell --stage pr<N> -- \
 *     pnpm --filter @bike4mind/scripts help:translate es ja
 *
 *   Flags: --force re-translates even when the English source is unchanged.
 *
 * Incremental: each translated file records a `sourceHash` of its English source
 * in frontmatter; a re-run skips articles whose English source hasn't changed.
 *
 * KNOWN LIMITATION (Phase 1): in-page anchor links (`[x](#a-heading)`) point at
 * English-derived anchors. Because headings are translated, a locale's TOC anchors
 * are recomputed from the translated text and may not match those fragments. The
 * model is told to leave link targets verbatim rather than guess; fixing anchor
 * parity across locales is deferred.
 */

import { Logger } from '@bike4mind/observability';
import { connectDB } from '@bike4mind/database';
import { createHash } from 'crypto';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import matter from 'gray-matter';
import { Resource } from 'sst';
import { DEFAULT_LOCALE, loadHelpArticles, localeContentRoot, type LoadedHelpArticle } from './loadHelpArticles.js';
import type { HelpFrontmatter } from './types.js';

dotenv.config();

/** Frontmatter string fields worth translating; everything else is preserved as-is. */
const TRANSLATABLE_FIELDS = ['title', 'description', 'sidebar_label'] as const;

/** Frontmatter key holding the hash of the English source this translation was built from. */
const SOURCE_HASH_KEY = 'sourceHash';
/** Frontmatter key recording which locale this content was translated from. */
const TRANSLATED_FROM_KEY = 'translatedFrom';

// --- Pure helpers (exported for unit tests; no DB/LLM/fs dependencies) ---

/** Stable content hash of an English source article, used for incremental re-translation. */
export function hashSource(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Strip a leading/trailing markdown code fence a model may wrap output in despite
 * instructions not to. Mirrors the defensive cleanup in syncTranslations.ts.
 */
export function stripCodeFence(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json|markdown|md)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

/** Extract the translatable string fields present on an article's frontmatter. */
export function translatableFields(frontmatter: HelpFrontmatter): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const key of TRANSLATABLE_FIELDS) {
    const value = frontmatter[key];
    if (typeof value === 'string' && value.trim()) fields[key] = value;
  }
  return fields;
}

/**
 * Build the translated file's frontmatter: original frontmatter with translated
 * fields overlaid, plus provenance metadata (source hash + source locale) so a
 * later run can tell whether the English source changed.
 */
export function buildTranslatedFrontmatter(
  original: HelpFrontmatter,
  translatedFields: Record<string, string>,
  sourceHash: string
): Record<string, unknown> {
  return {
    ...original,
    ...translatedFields,
    [SOURCE_HASH_KEY]: sourceHash,
    [TRANSLATED_FROM_KEY]: DEFAULT_LOCALE,
  };
}

/**
 * Decide whether an article needs (re)translation for a locale. Translates when
 * the target file is missing, when its recorded source hash differs from the
 * current English source, or when `force` is set.
 */
export function needsTranslation(existingRaw: string | null, sourceHash: string, force: boolean): boolean {
  if (force || existingRaw === null) return true;
  try {
    const { data } = matter(existingRaw) as { data: Record<string, unknown> };
    return data[SOURCE_HASH_KEY] !== sourceHash;
  } catch {
    return true;
  }
}

/** Parse CLI args into a locale list and flags. Rejects English and empty input. */
export function parseArgs(argv: string[]): { locales: string[]; force: boolean } {
  const force = argv.includes('--force');
  const locales = argv.filter(a => !a.startsWith('--'));
  return { locales, force };
}

// --- Translation runner ---

type CompleteFn = (prompt: string) => Promise<string>;

class HelpTranslator {
  /**
   * Resolve the MongoDB connection string. Mirrors syncTranslations.ts /
   * migrationManager.ts: prefer an explicit MONGODB_URI, else the SST-linked
   * resource for the current stage (requires the %STAGE% placeholder so we never
   * guess the wrong database).
   */
  private resolveMongoUri(): string | undefined {
    if (process.env.MONGODB_URI) return process.env.MONGODB_URI;
    let uri: string;
    try {
      uri = Resource.MONGODB_URI.value;
    } catch {
      return undefined;
    }
    if (!uri.includes('%STAGE%')) {
      throw new Error(
        'Resource.MONGODB_URI is missing the %STAGE% placeholder - refusing to guess the target database. Set MONGODB_URI explicitly to override.'
      );
    }
    return uri.replace('%STAGE%', Resource.App.stage);
  }

  /**
   * Connect to the DB once, resolve the operations model once, and return a
   * `complete(prompt)` helper reused for every article/locale in the run.
   */
  private async createCompleteFn(mongoUri: string): Promise<CompleteFn> {
    // Imported lazily (as in syncTranslations.ts) so the script's pure helpers can
    // be unit-tested without pulling in the app service graph.
    const { OperationsModelService } = await import('../../../apps/client/services/operationsModelService');

    await connectDB(mongoUri, new Logger({}));
    const { modelInfo, llm } = await OperationsModelService.getOperationsModel();
    if (!llm) throw new Error(`No LLM found for operations model ${modelInfo.id}`);
    console.log(`Using operations model for translation: ${modelInfo.name} (${modelInfo.id})`);

    return async (prompt: string): Promise<string> => {
      let out = '';
      await llm.complete(
        modelInfo.id,
        [{ role: 'user', content: prompt }],
        {},
        async (texts: (string | null | undefined)[]) => {
          for (const t of texts) if (typeof t === 'string') out += t;
        }
      );
      return out;
    };
  }

  /** Translate the article body (Markdown), preserving all non-prose syntax. */
  private async translateBody(complete: CompleteFn, body: string, targetLang: string): Promise<string> {
    if (!body.trim()) return body;
    const prompt = `Translate the following Markdown document from English to ${targetLang}.

Rules:
- Translate ONLY human-readable prose and heading text.
- Preserve ALL Markdown syntax exactly: headings (#), lists, tables, blockquotes, emphasis.
- Do NOT translate or alter: fenced code blocks, inline code, URLs, image paths, HTML tags/attributes, or link targets (the part in parentheses, including any #anchor fragments).
- Keep line structure and blank lines intact.
- Return ONLY the translated Markdown, with no surrounding commentary and no code fence around the whole document.

Markdown to translate:
${body}`;
    return stripCodeFence(await complete(prompt));
  }

  /** Translate the small set of frontmatter string fields via a JSON round-trip. */
  private async translateFields(
    complete: CompleteFn,
    fields: Record<string, string>,
    targetLang: string
  ): Promise<Record<string, string>> {
    if (Object.keys(fields).length === 0) return {};
    const prompt = `Translate the following JSON object's values from English to ${targetLang}. Keep the keys unchanged. Respond with ONLY the translated JSON object, no commentary, no code fence.

${JSON.stringify(fields, null, 2)}`;
    const cleaned = stripCodeFence(await complete(prompt));
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    const result: Record<string, string> = {};
    for (const key of Object.keys(fields)) {
      result[key] = typeof parsed[key] === 'string' ? (parsed[key] as string) : fields[key];
    }
    return result;
  }

  /** Translate one article into one locale and write it, or return false if skipped. */
  private async translateArticle(
    complete: CompleteFn,
    article: LoadedHelpArticle,
    locale: string,
    force: boolean
  ): Promise<boolean> {
    const rawSource = fs.readFileSync(article.filePath, 'utf-8');
    const sourceHash = hashSource(rawSource);
    const destPath = path.join(localeContentRoot(locale), article.relativePath);

    const existing = fs.existsSync(destPath) ? fs.readFileSync(destPath, 'utf-8') : null;
    if (!needsTranslation(existing, sourceHash, force)) {
      return false;
    }

    const translatedBody = await this.translateBody(complete, article.content, locale);
    const translatedFields = await this.translateFields(complete, translatableFields(article.frontmatter), locale);
    const frontmatter = buildTranslatedFrontmatter(article.frontmatter, translatedFields, sourceHash);

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, matter.stringify(translatedBody, frontmatter), 'utf-8');
    return true;
  }

  async run(argv: string[]): Promise<number> {
    const { locales, force } = parseArgs(argv);
    if (locales.length === 0) {
      console.error('Usage: help:translate <locale...> [--force]  (e.g. help:translate es ja)');
      return 1;
    }
    if (locales.includes(DEFAULT_LOCALE)) {
      console.error(`Refusing to translate into '${DEFAULT_LOCALE}': it is the canonical source, not a target.`);
      return 1;
    }

    const mongoUri = this.resolveMongoUri();
    if (!mongoUri) {
      console.error(
        'Could not resolve MongoDB URI - set MONGODB_URI directly, or run under `sst shell` so it resolves from Resource for the current stage. See apps/client/app/locales/README.md.'
      );
      return 1;
    }

    const articles = await loadHelpArticles(DEFAULT_LOCALE);
    console.log(`Loaded ${articles.length} English help articles.`);

    const complete = await this.createCompleteFn(mongoUri);

    let hadFailure = false;
    for (const locale of locales) {
      console.log(`\n=== Translating to ${locale} ===`);
      let translated = 0;
      let skipped = 0;
      for (const article of articles) {
        try {
          const didWrite = await this.translateArticle(complete, article, locale, force);
          if (didWrite) {
            translated++;
            console.log(`  translated: ${article.relativePath}`);
          } else {
            skipped++;
          }
        } catch (error) {
          hadFailure = true;
          console.error(`  FAILED: ${locale}/${article.relativePath}:`, error);
        }
      }
      console.log(`  ${locale}: ${translated} translated, ${skipped} unchanged/skipped`);
    }

    console.log('\nDone. Run `pnpm help:regenerate` to rebuild the index + bundle with the new locales.');
    return hadFailure ? 1 : 0;
  }
}

// Only run when invoked directly, so unit tests can import the pure helpers above.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  new HelpTranslator()
    .run(process.argv.slice(2))
    .then(code => process.exit(code))
    .catch(err => {
      console.error('Error translating help content:', err);
      process.exit(1);
    });
}
