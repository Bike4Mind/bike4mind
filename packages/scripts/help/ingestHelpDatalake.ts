/**
 * Mirror the public help corpus into the `system-help` data lake.
 *
 * Turns the generated help corpus into a first-class, Mongo-backed data-lake corpus so the
 * EXISTING in-worker semantic search (`search_knowledge_base` -> `semanticDataLakeSearch`) can
 * surface help in any chat - no new tool, endpoint, auth, or copyFiles. The `system-help` lake
 * (b4m-core/common/src/constants/dataLakes.ts) declares no requiredUserTag/requiredEntitlement.
 *
 * What it writes: one FabFile per public help article (tagged `datalake:system-help` + `help:<slug>`,
 * which is exactly what fabFileSearchQuery scopes on) plus its vectorized FabFileChunks. Vectors are
 * produced with the deployment's `defaultEmbeddingModel` - the SAME model the KB search embeds the
 * query with - so cosine similarity is meaningful. No S3 is touched: semantic search reads chunk
 * vectors + file metadata from Mongo (excludeContent), not the file body.
 *
 * DIFFERENTIAL, not delete-and-recreate. Each article's body is fingerprinted into the FabFile's
 * `contentHash`, so a re-run keeps every member whose hash AND `embeddingModel` still match, and
 * only deletes/creates what actually moved. That is what makes an unattended re-run safe on a live
 * retrieval surface: a blanket re-mirror would empty the lake and spend a full re-embed on every
 * tick, leaving a window on each one where `search_knowledge_base` finds no help at all. The
 * steady state here is zero writes and zero embedding calls.
 *
 * Convergence is still total in both directions - a newly published slug is created, and a slug
 * that left the corpus (or a duplicate member for a slug) is deleted, so it stops being retrievable.
 *
 * Two drivers come through here, so neither can drift from the other:
 *  - `ingest-help-datalake.ts`, run by hand through `sst shell` (the bootstrap: it is what first
 *    creates the lake, and therefore what fixes the owner the scheduled driver reuses);
 *  - `apps/client/server/cron/helpDatalakeIngest.ts`, the scheduled re-sync, whose corpus arrives
 *    in the Lambda bundle via copyFiles rather than from a checkout.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  countCodePoints,
  KnowledgeType,
  type IDataLakeRepository,
  type IFabFileChunkDocument,
  type IFabFileChunkRepository,
  type IFabFileDocument,
  type IFabFileRepository,
  type SupportedEmbeddingModel,
} from '@bike4mind/common';
import {
  EmbeddingFactory,
  getProviderFromModel,
  resolveEmbeddingConfig,
  type EmbeddingKeyTable,
} from '@bike4mind/fab-pipeline';
import { chunkByHeadings, stripFrontmatter } from './utils.js';
import type { HelpIndex, HelpIndexEntry } from './types.js';

export const HELP_DATALAKE_SLUG = 'system-help';
export const HELP_DATALAKE_TAG = `datalake:${HELP_DATALAKE_SLUG}`;
export const HELP_FILE_TAG_PREFIX = 'help:';

/**
 * Creates bounded per run so one tick cannot outlive the caller's timeout. Deletes are not capped:
 * they are cheap, and leaving a withdrawn article retrievable is the failure this exists to stop.
 * A capped run reports `deferred` and the next run picks the remainder up.
 */
const DEFAULT_MAX_CREATES_PER_RUN = 200;

/** Rough token estimate (chars/4); parity with the help embeddings vectorizer's heuristic. */
const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

/**
 * Build the chunk embedder both drivers pass as `deps.embed`.
 *
 * Goes through the shared `resolveEmbeddingConfig` rather than mapping provider to credential
 * itself: a keyless provider (Bedrock) must reach the factory with an empty config, and the
 * hand-rolled mapping this replaced treated an unrecognised provider as needing an OpenAI key.
 * Throws rather than warn-and-skip, because a run that silently embedded nothing would report a
 * clean no-op while the corpus went unmirrored.
 */
export function createHelpEmbedder(
  embeddingModel: SupportedEmbeddingModel,
  apiKeyTable: EmbeddingKeyTable | null | undefined
): (text: string) => Promise<number[]> {
  const provider = getProviderFromModel(embeddingModel);
  const { config, missing } = resolveEmbeddingConfig(provider, apiKeyTable);
  if (missing) {
    throw new Error(`No ${missing} credential resolved for embedding model ${embeddingModel}; cannot embed chunks.`);
  }
  const service = new EmbeddingFactory(config).createEmbeddingService(embeddingModel);
  return text => service.generateEmbedding(text);
}

export interface HelpDatalakeLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

export interface HelpDatalakeIngestDeps {
  db: {
    fabFiles: Pick<IFabFileRepository, 'findIdsByDataLakeTag' | 'findAllInIds' | 'deleteManyInIds' | 'create'>;
    fabFileChunks: Pick<IFabFileChunkRepository, 'deleteManyByFabFileId' | 'bulkInsert'>;
    dataLakes: Pick<IDataLakeRepository, 'findBySlug' | 'create' | 'update'>;
  };
  /** Embeds one chunk with the deployment's `defaultEmbeddingModel`. */
  embed: (text: string) => Promise<number[]>;
  /**
   * Stamped on every file so a later model change is detectable; must be `embed`'s model. A member
   * embedded with a different model is re-created even when its content hash still matches, because
   * its vectors are not comparable to the query vectors the KB search now produces.
   */
  embeddingModel: string;
  logger: HelpDatalakeLogger;
}

export interface HelpDatalakeIngestOptions {
  /** FabFile owner. Also whose effective LLM keys the caller's `embed` was built from. */
  userId: string;
  /** Absolute path to the generated `help-index.json`. */
  helpIndexPath: string;
  /**
   * Absolute path to the markdown root that `HelpIndexEntry.filePath` is relative to -
   * `docs-site/docs` at source, `apps/client/public/help-content` once bundled. Both layouts
   * resolve identically because bundle-help-content.ts preserves the docs-root-relative path.
   */
  helpContentRoot: string;
  /** Bounds the embedding work one run will do. Defaults to DEFAULT_MAX_CREATES_PER_RUN. */
  maxCreatesPerRun?: number;
  dryRun?: boolean;
}

export interface HelpDatalakeIngestResult {
  publicEntries: number;
  /** Members kept as-is: content hash and embedding model both still match. */
  unchanged: number;
  created: number;
  removed: number;
  chunksCreated: number;
  /** Creates left for the next run by `maxCreatesPerRun`. */
  deferred: number;
  /** Indexed public slugs whose markdown was not found under `helpContentRoot`. */
  missingContent: string[];
}

interface DesiredArticle {
  entry: HelpIndexEntry;
  markdown: string;
  body: string;
  contentHash: string;
}

/** The lake's own `help:<slug>` tag, or null on a member missing it. */
function memberSlug(file: IFabFileDocument): string | null {
  const tag = file.tags?.find(t => t.name.startsWith(HELP_FILE_TAG_PREFIX));
  return tag ? tag.name.slice(HELP_FILE_TAG_PREFIX.length) : null;
}

/** Ensure the lake row exists and is active; returns its id. */
async function ensureLake(deps: HelpDatalakeIngestDeps, opts: HelpDatalakeIngestOptions): Promise<string | null> {
  const existing = await deps.db.dataLakes.findBySlug(HELP_DATALAKE_SLUG);
  if (!existing) {
    deps.logger.info(`Creating public data lake "${HELP_DATALAKE_SLUG}"`);
    if (opts.dryRun) return null;
    // Registered as a DB lake rather than a hardcoded constant so it doesn't alter global
    // data-lake access semantics in the unit-tested DATA_LAKES fallback set.
    const created = await deps.db.dataLakes.create({
      name: 'Help Center',
      slug: HELP_DATALAKE_SLUG,
      description: 'Bike4Mind help documentation, searchable by all users.',
      fileTagPrefix: HELP_FILE_TAG_PREFIX,
      datalakeTag: HELP_DATALAKE_TAG,
      createdByUserId: opts.userId,
      status: 'active',
    });
    return created?.id ?? null;
  }

  if (existing.status !== 'active') {
    deps.logger.info(`Reactivating data lake "${HELP_DATALAKE_SLUG}" (was ${existing.status})`);
    // Update only the field we're changing; spreading the whole doc would $set
    // every field (timestamps, counters) and risk clobbering on a shape change.
    if (!opts.dryRun) await deps.db.dataLakes.update({ id: existing.id, status: 'active' });
  }
  return existing.id;
}

/** Read the index and resolve each public entry's markdown + body fingerprint. */
function loadDesiredCorpus(
  opts: HelpDatalakeIngestOptions,
  logger: HelpDatalakeLogger
): { entries: HelpIndexEntry[]; desired: DesiredArticle[]; missingContent: string[] } {
  const helpIndex = JSON.parse(fs.readFileSync(opts.helpIndexPath, 'utf-8')) as HelpIndex;
  const entries = helpIndex.entries.filter(e => e.accessLevel === 'public');

  const desired: DesiredArticle[] = [];
  const missingContent: string[] = [];
  for (const entry of entries) {
    const candidates = [
      path.join(opts.helpContentRoot, entry.filePath),
      path.join(opts.helpContentRoot, `${entry.slug}/index.md`),
    ];
    const contentPath = candidates.find(p => fs.existsSync(p));
    if (!contentPath) {
      logger.warn(`  ! skipping ${entry.slug} - markdown not found (run help:bundle-content)`);
      missingContent.push(entry.slug);
      continue;
    }
    const markdown = stripFrontmatter(fs.readFileSync(contentPath, 'utf-8'));
    const body = `# ${entry.title}\n\n${markdown}`;
    desired.push({ entry, markdown, body, contentHash: createHash('sha256').update(body).digest('hex') });
  }
  return { entries, desired, missingContent };
}

export async function ingestHelpDatalake(
  deps: HelpDatalakeIngestDeps,
  opts: HelpDatalakeIngestOptions
): Promise<HelpDatalakeIngestResult> {
  const { logger } = deps;
  const maxCreates = opts.maxCreatesPerRun ?? DEFAULT_MAX_CREATES_PER_RUN;
  const lakeId = await ensureLake(deps, opts);

  const { entries, desired, missingContent } = loadDesiredCorpus(opts, logger);
  logger.info(`Public help articles in the index: ${entries.length}`);

  // Meta-tag only. This function writes both signals on every article (see below), so the narrow
  // scope already covers everything it created, and it deletes outright - widening it to the
  // prefix arm would let the mirror reach a file some other lake put a `help:` tag on.
  // OMITTING `fileTagPrefix` is what keeps it narrow: a registry scope carrying one matches the
  // open prefix arm (no ownership conjunct). So do not "helpfully" add the prefix.
  const existingIds = await deps.db.fabFiles.findIdsByDataLakeTag({
    kind: 'registry',
    datalakeTag: HELP_DATALAKE_TAG,
  });
  const existing = existingIds.length > 0 ? await deps.db.fabFiles.findAllInIds(existingIds) : [];

  // Diff by slug. A member is reusable only if its body fingerprint AND its embedding model still
  // match; anything else - a stale body, a re-embedded model, a member whose slug left the corpus,
  // a second member for a slug, a member with no `help:` tag at all - is removed.
  const desiredBySlug = new Map(desired.map(d => [d.entry.slug, d]));
  const keepBySlug = new Map<string, IFabFileDocument>();
  // Carries the slug, not just the id: what makes a member safe to delete is whether the revision
  // that replaces it is actually in the lake, and the slug is the only link back to that.
  const removable: { id: string; slug: string | null }[] = [];
  for (const file of existing) {
    const slug = memberSlug(file);
    const want = slug ? desiredBySlug.get(slug) : undefined;
    const reusable =
      !!slug &&
      !!want &&
      !keepBySlug.has(slug) &&
      file.contentHash === want.contentHash &&
      file.embeddingModel === deps.embeddingModel &&
      !!file.vectorized;
    if (reusable) keepBySlug.set(slug, file);
    else removable.push({ id: file.id, slug });
  }

  const toCreate = desired.filter(d => !keepBySlug.has(d.entry.slug));
  const creating = toCreate.slice(0, maxCreates);
  const deferred = toCreate.length - creating.length;
  if (deferred > 0) {
    logger.warn(`Capping this run at ${maxCreates} article(s); ${deferred} deferred to the next run`);
  }

  const result: HelpDatalakeIngestResult = {
    publicEntries: entries.length,
    unchanged: keepBySlug.size,
    created: 0,
    removed: 0,
    chunksCreated: 0,
    deferred,
    missingContent,
  };

  // Creates run FIRST, deletes after. A member is stale, not absent: replacing it before removing
  // it costs a few seconds of duplicate chunks for one slug, which a cosine-ranked, meta-tag-scoped
  // query absorbs, while the other order empties the lake and refills it one embed at a time. On
  // the first tick after this ships, and on any defaultEmbeddingModel change, the reuse gate
  // invalidates EVERY member at once - so that window is the whole corpus, not an edge case.
  const createdSlugs = new Set<string>();

  for (const article of creating) {
    const { entry, markdown, body, contentHash } = article;
    const sections = chunkByHeadings(markdown, entry.title);
    if (sections.length === 0) continue;

    if (opts.dryRun) {
      logger.info(`  (dry-run) ${entry.slug}: ${sections.length} chunks`);
      createdSlugs.add(entry.slug);
      result.created++;
      result.chunksCreated += sections.length;
      continue;
    }

    // Embed each section. Prepend the title for context; parity with the help vectorizer's input.
    const chunkPayloads: Omit<IFabFileChunkDocument, 'id'>[] = [];
    for (const section of sections) {
      const text = `# ${entry.title}\n\n${section.content}`;
      const vector = await deps.embed(text);
      const now = new Date();
      chunkPayloads.push({
        fabFileId: '',
        text,
        tokenCount: estimateTokens(text),
        charLength: countCodePoints(text),
        vector,
        createdAt: now,
        updatedAt: now,
      });
    }

    // Create the FabFile. Tags are what fabFileSearchQuery scopes on:
    //  - `datalake:system-help` -> the meta-tag (dataLakeTags match)
    //  - `help:<slug>`          -> the `help:` prefix match + encodes the slug for deep-linking
    //
    // MUST STAY IN SYNC with the invariant in dataLakeService/fallbackLakeTags: a file carrying a
    // lake meta-tag must also carry a tag under that lake's fileTagPrefix, or it is invisible to
    // tag-counts and to the Explorer tag tree. This writes through the repository rather than an
    // API door, so no reconciler runs here - the `help:<slug>` tag is what satisfies it, and
    // dropping it would silently reproduce the bug this invariant exists to prevent. The
    // `help:<slug>` tag is also how a re-run identifies this member, so it is load-bearing twice.
    const fabFile = await deps.db.fabFiles.create({
      userId: opts.userId,
      fileName: entry.title,
      fileSize: Buffer.byteLength(body),
      // The re-run's whole diff turns on this: it is the only record of WHICH revision of the
      // article the lake currently holds.
      contentHash,
      mimeType: 'text/markdown',
      type: KnowledgeType.TEXT,
      tags: [
        { name: HELP_DATALAKE_TAG, strength: 1 },
        { name: `${HELP_FILE_TAG_PREFIX}${entry.slug}`, strength: 1 },
      ],
      primaryTag: HELP_DATALAKE_TAG,
      system: true,
      chunked: true,
      chunkCount: chunkPayloads.length,
      chunkedCharCount: chunkPayloads.reduce((sum, c) => sum + (c.charLength ?? 0), 0),
      vectorized: true,
      vectorizedChunkCount: chunkPayloads.length,
      embeddingModel: deps.embeddingModel,
      status: 'complete',
      // Sharing/ACL fields (required by the shareable document base). Data-lake visibility comes
      // from the `datalake:system-help` tag + the public lake config, not these per-doc shares.
      isGlobalRead: true,
      isGlobalWrite: false,
      users: [],
      groups: [],
    });

    await deps.db.fabFileChunks.bulkInsert(chunkPayloads.map(c => ({ ...c, fabFileId: fabFile.id })));

    createdSlugs.add(entry.slug);
    result.created++;
    result.chunksCreated += chunkPayloads.length;
    logger.info(`  ok ${entry.slug}: ${chunkPayloads.length} chunks`);
  }

  // Delete only what the lake no longer needs: a member with no slug, a slug that left the index,
  // or a slug whose current revision is now present (kept or just created). A member whose
  // replacement was deferred by maxCreatesPerRun - or skipped because it chunked to nothing -
  // survives to the next run. Stale help still answers; a hole in the corpus does not.
  const removeIds = removable
    .filter(({ slug }) => !slug || !desiredBySlug.has(slug) || keepBySlug.has(slug) || createdSlugs.has(slug))
    .map(({ id }) => id);
  result.removed = removeIds.length;

  if (removeIds.length > 0) {
    logger.info(`Removing ${removeIds.length} stale/withdrawn help fabfile(s) + their chunks`);
    if (!opts.dryRun) {
      // No self-host OpenSearch mirror needed here: both drivers run against an SST-deployed
      // stage, which never sets B4M_SELF_HOST - so selfHostOpenSearchEnabled() can never be
      // true on a path that reaches this line.
      //
      // Files go first, chunks after (#2583). This cron has no redelivery on a mid-run failure -
      // it runs directly in a Lambda, not behind a queue - so it is the least protected of the
      // sites this ordering matters for. Chunks-then-files used to leave an interruption between
      // the two steps stranding a FILE with a stale vectorizedChunkCount over zero real chunks -
      // unretrievable, but every counter-based health surface reported it vectorized. This order
      // fails the other, harmless way: an interruption here only orphans chunk rows, unreachable
      // without their file and already a tracked, separately cleanable class (#2539).
      await deps.db.fabFiles.deleteManyInIds(removeIds);
      for (const id of removeIds) await deps.db.fabFileChunks.deleteManyByFabFileId(id);
    }
  }

  // Heartbeat, not a change marker: stamped on every completed run so an operator reading the lake
  // can tell "verified in sync an hour ago" from "nothing has re-run since July".
  if (lakeId && !opts.dryRun) {
    await deps.db.dataLakes.update({ id: lakeId, lastSyncAt: new Date() });
  }

  logger.info(
    `${opts.dryRun ? '(dry-run) ' : ''}Done. ${result.unchanged} unchanged, ${result.created} created ` +
      `(${result.chunksCreated} chunk(s)), ${result.removed} removed in ${HELP_DATALAKE_TAG}.`
  );
  return result;
}
