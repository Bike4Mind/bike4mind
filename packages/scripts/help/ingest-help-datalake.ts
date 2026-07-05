#!/usr/bin/env tsx
/**
 * Ingest the help documentation into the public "Help Center" data lake (Option F).
 *
 * Turns the generated help corpus into a first-class, Mongo-backed data-lake corpus so the
 * EXISTING in-worker semantic search (`search_knowledge_base` -> `semanticDataLakeSearch`) can
 * surface help in any chat - no new tool, endpoint, auth, or copyFiles. The `system-help` lake
 * (b4m-core/common/src/constants/dataLakes.ts) declares no requiredUserTag/requiredEntitlement,
 * so it is visible to every authenticated user.
 *
 * What it writes: one FabFile per public help article (tagged `datalake:system-help` + `help:<slug>`,
 * which is exactly what fabFileSearchQuery scopes on) plus its vectorized FabFileChunks. Vectors are
 * produced with the deployment's `defaultEmbeddingModel` - the SAME model the KB search embeds the
 * query with - so cosine similarity is meaningful. No S3 is touched: semantic search reads chunk
 * vectors + file metadata from Mongo (excludeContent), not the file body.
 *
 * Idempotent: existing `datalake:system-help` files (and their chunks) are removed first, so the
 * lake is a clean mirror of the current docs on every run - that's the maintainability win.
 *
 * Source of truth: apps/client/app/generated/help-index.json + apps/client/public/help-content/*
 * (produced by `pnpm --filter @bike4mind/scripts help:regenerate`). Run that first if stale.
 *
 * Usage (per environment - needs DB + an embedding API key, provided by `sst shell`):
 *   npx sst shell --stage dev        -- tsx packages/scripts/help/ingest-help-datalake.ts --userId <systemUserId>
 *   npx sst shell --stage production -- tsx packages/scripts/help/ingest-help-datalake.ts --userId <systemUserId>
 *
 * --userId is the FabFile owner (use a system/admin account) and whose effective LLM keys embed
 * the chunks. --dry-run reports what would happen without writing.
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Resource } from 'sst';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  connectDB,
  fabFileRepository,
  fabFileChunkRepository,
  adminSettingsRepository,
  apiKeyRepository,
  dataLakeRepository,
} from '@bike4mind/database';
import { apiKeyService } from '@bike4mind/services';
import { EmbeddingFactory, getProviderFromModel } from '@bike4mind/fab-pipeline';
import { getSettingsByNames } from '@bike4mind/utils';
import { KnowledgeType, isSupportedEmbeddingModel, type IFabFileChunkDocument } from '@bike4mind/common';
import { chunkByHeadings, stripFrontmatter } from './utils.js';
import type { HelpIndex } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const HELP_INDEX_PATH = path.join(REPO_ROOT, 'apps/client/app/generated/help-index.json');
const HELP_CONTENT_ROOT = path.join(REPO_ROOT, 'apps/client/public/help-content');

const DATALAKE_SLUG = 'system-help';
const DATALAKE_TAG = `datalake:${DATALAKE_SLUG}`;
const FILE_TAG_PREFIX = 'help:';

/** Rough token estimate (chars/4); parity with the help embeddings vectorizer's heuristic. */
const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

interface Options {
  userId: string;
  dryRun: boolean;
}

async function main(opts: Options): Promise<number> {
  // --- Connect ---
  const dbUri = Resource.MONGODB_URI.value.replace('%STAGE%', Resource.App.stage);
  await connectDB(dbUri);
  console.log(`Connected (stage: ${Resource.App.stage})`);

  // --- Resolve embedding model + the owner's effective API key ---
  const embeddingModel = await adminSettingsRepository.getSettingsValue('defaultEmbeddingModel');
  if (!embeddingModel || !isSupportedEmbeddingModel(embeddingModel)) {
    throw new Error(`defaultEmbeddingModel is unset or unsupported: ${String(embeddingModel)}`);
  }
  const apiKeyTable = await apiKeyService.getEffectiveLLMApiKeys(opts.userId, {
    db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
    getSettingsByNames,
  });
  const provider = getProviderFromModel(embeddingModel);
  const embeddingConfig: { openaiApiKey?: string | null; voyageApiKey?: string | null } = {};
  // Only OpenAI and Voyage embeddings need an API key. Bedrock (e.g.
  // amazon.titan-embed-text-v2:0) and other IAM/keyless providers must NOT be
  // blocked by a key guard; require the key only for the providers that use one.
  if (provider === 'openai') {
    embeddingConfig.openaiApiKey = apiKeyTable?.openai;
    if (!embeddingConfig.openaiApiKey) {
      throw new Error(`No OpenAI API key resolved for user ${opts.userId}; cannot embed chunks.`);
    }
  } else if (provider === 'voyageai') {
    embeddingConfig.voyageApiKey = apiKeyTable?.voyageai;
    if (!embeddingConfig.voyageApiKey) {
      throw new Error(`No Voyage API key resolved for user ${opts.userId}; cannot embed chunks.`);
    }
  }
  const embeddingService = new EmbeddingFactory(embeddingConfig).createEmbeddingService(embeddingModel);
  console.log(`Embedding model: ${embeddingModel} (${provider})`);

  // --- Ensure the PUBLIC "Help Center" data lake exists (no requiredUserTag/requiredEntitlement
  // => getDynamicDataLakeAccess returns it for every authenticated user). Registered as a DB lake
  // rather than a hardcoded constant so it doesn't alter global data-lake access semantics in the
  // unit-tested DATA_LAKES fallback set. ---
  const existingLake = await dataLakeRepository.findBySlug(DATALAKE_SLUG);
  if (!existingLake) {
    console.log(`Creating public data lake "${DATALAKE_SLUG}"…`);
    if (!opts.dryRun) {
      await dataLakeRepository.create({
        name: 'Help Center',
        slug: DATALAKE_SLUG,
        description: 'Bike4Mind help documentation, searchable by all users.',
        fileTagPrefix: FILE_TAG_PREFIX,
        datalakeTag: DATALAKE_TAG,
        createdByUserId: opts.userId,
        status: 'active',
      });
    }
  } else if (existingLake.status !== 'active') {
    console.log(`Reactivating data lake "${DATALAKE_SLUG}" (was ${existingLake.status})…`);
    // Update only the field we're changing; spreading the whole doc would $set
    // every field (timestamps, counters) and risk clobbering on a shape change.
    if (!opts.dryRun) await dataLakeRepository.update({ id: existingLake.id, status: 'active' });
  }

  // --- Load the public help corpus from the generated index + bundled markdown ---
  const helpIndex = JSON.parse(fs.readFileSync(HELP_INDEX_PATH, 'utf-8')) as HelpIndex;
  const publicEntries = helpIndex.entries.filter(e => e.accessLevel === 'public');
  console.log(`Public help articles to ingest: ${publicEntries.length}`);

  // --- Idempotency: clear the existing help lake so this run is a clean mirror ---
  const existingIds = await fabFileRepository.findIdsByDataLakeTag(DATALAKE_TAG);
  if (existingIds.length > 0) {
    console.log(`Removing ${existingIds.length} existing help fabfile(s) + their chunks…`);
    if (!opts.dryRun) {
      for (const id of existingIds) await fabFileChunkRepository.deleteManyByFabFileId(id);
      await fabFileRepository.deleteManyInIds(existingIds);
    }
  }

  let filesCreated = 0;
  let chunksCreated = 0;

  for (const entry of publicEntries) {
    // Resolve the bundled markdown: `${filePath}` then `${slug}/index.md` fallback.
    const candidates = [
      path.join(HELP_CONTENT_ROOT, entry.filePath),
      path.join(HELP_CONTENT_ROOT, `${entry.slug}/index.md`),
    ];
    const contentPath = candidates.find(p => fs.existsSync(p));
    if (!contentPath) {
      console.warn(`  ! skipping ${entry.slug} — markdown not found (run help:bundle-content)`);
      continue;
    }

    const raw = fs.readFileSync(contentPath, 'utf-8');
    const markdown = stripFrontmatter(raw);
    const sections = chunkByHeadings(markdown, entry.title);
    if (sections.length === 0) continue;

    // Embed each section. Prepend the title for context; parity with the help vectorizer's input.
    const chunkPayloads: Omit<IFabFileChunkDocument, 'id'>[] = [];
    if (!opts.dryRun) {
      for (const section of sections) {
        const text = `# ${entry.title}\n\n${section.content}`;
        const vector = await embeddingService.generateEmbedding(text);
        const now = new Date();
        chunkPayloads.push({
          fabFileId: '',
          text,
          tokenCount: estimateTokens(text),
          vector,
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    if (opts.dryRun) {
      console.log(`  (dry-run) ${entry.slug}: ${sections.length} chunks`);
      filesCreated++;
      chunksCreated += sections.length;
      continue;
    }

    // Create the FabFile. Tags are what fabFileSearchQuery scopes on:
    //  - `datalake:system-help` -> the meta-tag (dataLakeTags match)
    //  - `help:<slug>`          -> the `help:` prefix match + encodes the slug for deep-linking
    const fileBody = `# ${entry.title}\n\n${markdown}`;
    const fabFile = await fabFileRepository.create({
      userId: opts.userId,
      fileName: entry.title,
      fileSize: Buffer.byteLength(fileBody),
      mimeType: 'text/markdown',
      type: KnowledgeType.TEXT,
      tags: [
        { name: DATALAKE_TAG, strength: 1 },
        { name: `help:${entry.slug}`, strength: 1 },
      ],
      primaryTag: DATALAKE_TAG,
      system: true,
      chunked: true,
      chunkCount: chunkPayloads.length,
      vectorized: true,
      vectorizedChunkCount: chunkPayloads.length,
      embeddingModel,
      status: 'complete',
      // Sharing/ACL fields (required by the shareable document base). Data-lake visibility comes
      // from the `datalake:system-help` tag + the public lake config, not these per-doc shares.
      isGlobalRead: true,
      isGlobalWrite: false,
      users: [],
      groups: [],
    });

    await fabFileChunkRepository.bulkInsert(chunkPayloads.map(c => ({ ...c, fabFileId: fabFile.id })));

    filesCreated++;
    chunksCreated += chunkPayloads.length;
    console.log(`  ✓ ${entry.slug}: ${chunkPayloads.length} chunks`);
  }

  console.log(
    `\n${opts.dryRun ? '(dry-run) ' : ''}Done. ${filesCreated} help file(s), ${chunksCreated} chunk(s) in ${DATALAKE_TAG}.`
  );
  return 0;
}

const argv = yargs(hideBin(process.argv))
  .option('userId', { type: 'string', demandOption: true, describe: 'FabFile owner + whose LLM key embeds chunks' })
  .option('dry-run', { type: 'boolean', default: false, describe: 'Report without writing' })
  .parseSync();

main({ userId: argv.userId, dryRun: argv['dry-run'] })
  .then(code => process.exit(code))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
