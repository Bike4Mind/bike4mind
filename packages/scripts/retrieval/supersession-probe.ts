#!/usr/bin/env tsx
/**
 * Supersession-collapse probe: proves on a live DB that `EnableRetrievalSupersessionCollapse`
 * changes which GENERATION of a re-uploaded document semantic search serves.
 *
 * WHAT IT SEEDS. A dedicated, gate-less data lake (slug `supersession-probe`, never `system-help`)
 * holding three documents, each uploaded twice under the SAME `fileName` with different content -
 * a policy value that changed. The older generation's `createdAt` is force-backdated ~90 days so
 * the two generations are distinguishable by age. The identity key that `partitionBySupersession`
 * groups them on is the weakest (`fileName`) tier, since neither generation carries a
 * `relativePath` or a `driveFileId` - see `b4m-core/services/src/dataLakeService/supersession.ts`.
 *
 * WHY THE OLDER TEXT SCORES AT LEAST AS WELL. Each query is phrased close to the OLD sentence's own
 * wording, and the NEW generation only appends a trailing clause ("effective 2026"). Without
 * collapse, a purely relevance-ranked search has no reason to prefer the newer generation - it may
 * in fact prefer the older, more literal match. That is what makes the comparison meaningful: any
 * shift toward the NEW generation when the setting flips on is attributable to the collapse, not to
 * the ranking having favored it anyway.
 *
 * HOW IT MEASURES. Calls `semanticDataLakeSearch` (`b4m-core/services/src/dataLakeService`) DIRECTLY
 * rather than going through the `search_knowledge_base` chat tool: that tool's audit-event seam
 * (`RecordLakeAccessEventInput`) turned out to report `outcome: "unknown"` for a search that had, in
 * fact, served content - so `readRetrievalStatus` could never reach `served-content` even though the
 * logs showed real passages returned. `semanticDataLakeSearch` is also the layer that actually owns
 * `compareByScore` and the supersession partition, so calling it directly measures the mechanism
 * under test instead of a seam wrapped two layers above it. Its result already carries structured
 * `{chunkId, fileId, fileName, score}` per hit plus its own `supersession: SupersessionReport` - no
 * audit event, no model-facing text, no polling. Lake scope (`dataLakeTags`/`dataLakeTagPrefixes`/
 * `lakes`) is resolved the same way the known-working callers do: via
 * `dataLakeService.getDynamicDataLakeAccess`, the same core function
 * `apps/client/pages/api/data-lakes/semantic-search.ts` and the chat tool both sit on top of - see
 * that route's `resolveRetrievalLakeScope` -> `getDynamicDataLakeAccess` chain.
 *
 * Each served chunk is attributed to OLD/NEW by its `fileId`, looked up against the map built while
 * SEEDING - never by tag, since a tag is not what supersession collapses on and would misreport if
 * it ever drifted from the identity key.
 *
 * SETTINGS. `EnableRetrievalSupersessionCollapse` is read straight from `getSettingsValue` by
 * `semanticDataLakeSearch`'s caller (this script passes the read-back value explicitly, matching how
 * every real caller reads it once and passes it in - `semanticDataLakeSearch` itself never reads
 * settings). Toggling it in Mongo and dropping the settings cache (exactly as `recall-probe.ts` does
 * for its own two knobs) takes effect on the very next in-process call; this script also reads the
 * value BACK through `adminSettingsRepository.getSettingsValue` immediately after writing it and
 * asserts it matches, so a caching or wiring regression fails loudly here instead of silently
 * measuring the wrong configuration. The prior value is leased and restored in a `finally` and on
 * SIGINT/SIGTERM - this stage is shared, and this script must never leave the setting flipped for
 * anyone else.
 *
 * Usage (needs DB + an embedding key, which `sst shell` provides):
 *   for-env dev pnpm sst shell --stage dev -- pnpm --filter @bike4mind/scripts retrieval:supersession-probe
 *
 * No CLI flags: the probe user, lake and documents are fixed and idempotent (see SETUP below), so
 * the whole thing is safe to re-run - every run deletes and recreates its own FabFiles first.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resource } from 'sst';
import {
  AdminSettings,
  FabFile,
  adminSettingsRepository,
  apiKeyRepository,
  connectDB,
  dataLakeRepository,
  fabFileChunkRepository,
  fabFileRepository,
  organizationRepository,
  userRepository,
} from '@bike4mind/database';
import { getSettingsByNames, invalidateScopedSettingsCache, invalidateSettingsCache } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import { apiKeyService, dataLakeService, userService } from '@bike4mind/services';
import { EmbeddingFactory, getProviderFromModel } from '@bike4mind/fab-pipeline';
import {
  KnowledgeType,
  countCodePoints,
  isSupportedEmbeddingModel,
  type IFabFileChunkDocument,
  type IUserDocument,
  type SettingKey,
  type SupportedEmbeddingModel,
} from '@bike4mind/common';
import {
  assertAllAttributed,
  assertSupersessionSampleAttributed,
  attributeChunks,
  supersededCountFor,
  tallyGenerations,
  type ChunkAttribution,
  type Generation,
  type SeededFile,
} from './supersessionAttribution';

/** This file is packages/scripts/retrieval/, so the package root is two levels up. */
const SCRIPTS_PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const logger = new Logger();

// ---------------------------------------------------------------------------
// Fixed, idempotent test-data identity - all obviously probe-owned.
// ---------------------------------------------------------------------------

const LAKE_SLUG = 'supersession-probe';
const DATALAKE_TAG = `datalake:${LAKE_SLUG}`;
const FILE_TAG_PREFIX = 'supersession:';

const PROBE_USER_USERNAME = 'supersession-probe';
const PROBE_USER_EMAIL = 'supersession-probe@test.com';
const PROBE_USER_NAME = 'Supersession Probe (retrieval test data - safe to delete)';

/** How much older the OLD generation is stamped, in days. Comfortably outside any clock skew. */
const OLD_GENERATION_AGE_DAYS = 90;

const COLLAPSE_SETTING: SettingKey = 'EnableRetrievalSupersessionCollapse';

/** This script's own settings-lease row, distinct from recall-probe.ts's, so the two never
 *  contend with each other over an unrelated setting. */
const LEASE_SETTING = '__supersessionProbeLease';
const LEASE_STALE_AFTER_MS = 30 * 60 * 1000;

/**
 * One document, seeded as two FabFiles under the same `fileName`. `query` is phrased close to
 * `oldText`'s own wording (design rule: the OLD generation must score at least as well as NEW, so a
 * shift toward NEW after collapse is attributable to the setting, not to ranking already preferring
 * it). Real policy-style content, not lorem ipsum, so the embedding model has something to grip.
 */
type ProbeDoc = {
  fileName: string;
  oldText: string;
  newText: string;
  query: string;
};

const PROBE_DOCS: ProbeDoc[] = [
  {
    fileName: 'Expense Policy.txt',
    oldText: 'The expense reimbursement limit is $500 per month.',
    newText: 'The expense reimbursement limit is $750 per month, effective 2026.',
    query: 'What is the expense reimbursement limit?',
  },
  {
    fileName: 'PTO Carryover.txt',
    oldText: 'Employees may carry over up to 5 unused PTO days into the next calendar year.',
    newText: 'Employees may carry over up to 10 unused PTO days into the next calendar year, effective 2026.',
    query: 'How many unused PTO days can employees carry over into the next year?',
  },
  {
    fileName: 'Laptop Refresh.txt',
    oldText: 'Company laptops are refreshed every 4 years.',
    newText: 'Company laptops are refreshed every 3 years, effective 2026.',
    query: 'How often are company laptops refreshed?',
  },
];

// ---------------------------------------------------------------------------
// Settings lease (single setting) - same mechanics as recall-probe.ts's acquireSettingsLease,
// narrowed to the one knob this probe touches.
// ---------------------------------------------------------------------------

async function readSetting(name: string): Promise<string | null> {
  const row = await AdminSettings.findOne({ settingName: name }).lean<{ settingValue?: string } | null>();
  return row?.settingValue ?? null;
}

/**
 * Write a setting and drop the in-process settings caches, exactly as recall-probe.ts's
 * `writeSetting` does - including the hard-delete path, for the same reason: the soft-delete
 * plugin does not hook `updateOne`/`findOneAndUpdate`, so a plain `deleteOne` would tombstone a row
 * that still carries this probe's last value and break every future read AND write of this setting
 * on the stage. See `AdminSettingsModel.ts` (`softDeletePlugin`) and `db-core/src/utils/mongo.ts`.
 */
async function writeSetting(name: string, value: string | null): Promise<void> {
  if (value === null) {
    await AdminSettings.deleteOne({ settingName: name }, { hardDelete: true });
  } else {
    await AdminSettings.updateOne(
      { settingName: name },
      { $set: { settingValue: value, deletedAt: null } },
      { upsert: true }
    );
  }
  invalidateSettingsCache();
  invalidateScopedSettingsCache();
}

/**
 * `getSettingsValue` is typed as the union of EVERY admin setting's value shape, so it does not
 * narrow to this setting's boolean on its own. Narrow it here rather than casting.
 *
 * The throw is a TYPE guard, not a data-integrity check, and deliberately promises nothing about the
 * row: `EnableRetrievalSupersessionCollapse` is a `makeBooleanSetting` (`settings.ts`), whose schema
 * preprocesses the strings "true"/"false" and prefaults, and `getSettingsValue`
 * (`AdminSettingsModel.ts`) falls back to `defaultValue` whenever `safeParse` fails - so a garbage
 * row reads as `false` here rather than surfacing as a string. What actually catches a row this
 * probe cannot trust is the write-then-read-back assertion in `runOneConfig`, which compares this
 * value against what was just written.
 */
async function readCollapseSettingAsBoolean(): Promise<boolean> {
  const raw: unknown = await adminSettingsRepository.getSettingsValue(COLLAPSE_SETTING);
  if (raw === undefined || raw === null) return false;
  if (typeof raw !== 'boolean') {
    throw new Error(
      `${COLLAPSE_SETTING} read back as a non-boolean (${typeof raw}: ${String(raw)}). Refusing to ` +
        `measure: the probe cannot establish whether collapse was on for this configuration.`
    );
  }
  return raw;
}

/** Mongo duplicate key on the unique `settingName` index - the ONE error that means someone else
 *  won the race for the lease row. */
const isDuplicateKeyError = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;

async function acquireCollapseSettingLease(): Promise<{ originalValue: string | null; restore: () => Promise<void> }> {
  const holder = `${process.pid}@supersession-probe`;
  const now = Date.now();

  let acquired = false;
  try {
    const result = await AdminSettings.updateOne(
      { settingName: LEASE_SETTING },
      { $setOnInsert: { settingValue: JSON.stringify({ holder, startedAt: now }), deletedAt: null } },
      { upsert: true }
    );
    acquired = result.upsertedCount === 1;
  } catch (err) {
    // Only a duplicate key means another run holds the lease. A connection reset, timeout or auth
    // failure must NOT be reported as a held lease: the operator would be told to go clear a row
    // that may not exist, with `holder unknown` because the read below failed for the same reason.
    if (!isDuplicateKeyError(err)) throw err;
    acquired = false;
  }

  if (!acquired) {
    const existing = await readSetting(LEASE_SETTING);
    let startedAt = 0;
    try {
      startedAt = Number(JSON.parse(existing ?? '{}')?.startedAt ?? 0);
    } catch {
      startedAt = 0;
    }
    const ageMs = now - startedAt;
    const staleHint =
      startedAt > 0 && ageMs > LEASE_STALE_AFTER_MS
        ? ` That lease is older than ${LEASE_STALE_AFTER_MS / 60_000} minutes, so the run holding it probably ` +
          `died. Confirm no probe is running, verify ${COLLAPSE_SETTING} by hand, then clear the ` +
          `"${LEASE_SETTING}" row to release it.`
        : '';
    throw new Error(
      `Another supersession-probe run holds the settings lease on this stage (${existing ?? 'holder unknown'}). ` +
        `Refusing to start: a second run would capture the first run's mutated ${COLLAPSE_SETTING} as its ` +
        `baseline and restore that on exit, permanently discarding the stage's real configuration.${staleHint}`
    );
  }

  const originalValue = await readSetting(COLLAPSE_SETTING);

  let inFlight: Promise<void> | null = null;
  const runRestore = async (): Promise<void> => {
    try {
      await writeSetting(COLLAPSE_SETTING, originalValue);
      logger.log(`Restored ${COLLAPSE_SETTING} to ${originalValue === null ? '(unset)' : originalValue}.`);
    } catch (err) {
      // Return WITHOUT releasing the lease. While the setting is stranded, that row is the only
      // marker that this stage is mid-probe, and it is the only thing stopping the next run from
      // reading the stranded value as its own `originalValue` and restoring it on exit - which
      // would flip collapse on permanently for everyone on the stage, with no error anywhere. Same
      // invariant as recall-probe.ts's "released last" block; it is the part of those mechanics
      // this narrowing had dropped.
      logger.error(
        `FAILED to restore ${COLLAPSE_SETTING} to ${originalValue === null ? '(unset)' : originalValue} on stage ` +
          `${Resource.App.stage}. Restore it BY HAND, then clear the "${LEASE_SETTING}" row - it is left ` +
          `behind on purpose to block the next run until you have.`,
        err
      );
      return;
    }
    try {
      await writeSetting(LEASE_SETTING, null);
    } catch (err) {
      logger.warn(`Could not release the "${LEASE_SETTING}" row. Clear it by hand before the next run.`, err);
    }
  };
  const restore = (): Promise<void> => (inFlight ??= runRestore());

  const onSignal = (signal: NodeJS.Signals): void => {
    void (async () => {
      logger.warn(`\nReceived ${signal}. Restoring ${COLLAPSE_SETTING} before exiting.`);
      await restore();
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      process.kill(process.pid, signal);
    })();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  return {
    originalValue,
    restore: async () => {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      await restore();
    },
  };
}

// ---------------------------------------------------------------------------
// Setup: probe user, lake, and the six FabFiles (idempotent).
// ---------------------------------------------------------------------------

async function findOrCreateProbeUser(): Promise<IUserDocument> {
  const existing = await userRepository.findByEmail(PROBE_USER_EMAIL);
  if (existing) {
    logger.log(`Reusing probe user ${existing.id} (${PROBE_USER_EMAIL}).`);
    return existing;
  }
  // userService.createUser fills in every other required IUser field with the same defaults the
  // real signup path uses (see b4m-core/services/src/userService/create.ts) - reused rather than
  // reimplemented so this script never has to independently guess IUser's required shape.
  const created = await userService.createUser(
    {
      username: PROBE_USER_USERNAME,
      email: PROBE_USER_EMAIL,
      name: PROBE_USER_NAME,
      tags: ['test-data'],
      emailVerified: true,
    },
    { db: { users: userRepository } }
  );
  logger.log(`Created probe user ${created.id} (${PROBE_USER_EMAIL}).`);
  return created as IUserDocument;
}

async function findOrCreateProbeLake(userId: string): Promise<{ lakeId: string }> {
  const existing = await dataLakeRepository.findBySlug(LAKE_SLUG);
  if (existing) {
    if (existing.status !== 'active') {
      logger.log(`Reactivating data lake "${LAKE_SLUG}" (was ${existing.status}).`);
      await dataLakeRepository.update({ id: existing.id, status: 'active' });
    } else {
      logger.log(`Reusing data lake "${LAKE_SLUG}" (${existing.id}).`);
    }
    return { lakeId: existing.id };
  }
  const created = await dataLakeRepository.create({
    name: 'Supersession Probe',
    slug: LAKE_SLUG,
    description: 'One-off measurement lake for the supersession-collapse probe. Safe to delete.',
    fileTagPrefix: FILE_TAG_PREFIX,
    datalakeTag: DATALAKE_TAG,
    createdByUserId: userId,
    status: 'active',
  });
  logger.log(`Created data lake "${LAKE_SLUG}" (${created.id}).`);
  return { lakeId: created.id };
}

/** Idempotency: wipe any FabFiles (and their chunks) this probe left behind on a prior run. */
async function clearPreviousRun(): Promise<void> {
  const existingIds = await fabFileRepository.findIdsByDataLakeTag({ kind: 'registry', datalakeTag: DATALAKE_TAG });
  if (existingIds.length === 0) return;
  logger.log(`Removing ${existingIds.length} FabFile(s) from a previous run...`);
  // Each row goes first and its own chunks immediately after (#2583), the same ordering as the
  // three production sites. Chunks-then-rows left an interruption between the two stranding a ROW
  // with a stale vectorizedChunkCount over zero real chunks - unretrievable while every
  // counter-based health surface reads it as vectorized, which on this probe's own lake is
  // precisely the corruption it would then go on to measure. Paired per id rather than bulk so an
  // interrupted clear leaves the ids it has not reached still named by `findIdsByDataLakeTag`.
  //
  // hardDelete, NOT deleteManyInIds: `FabFileSchema` carries the soft-delete plugin, whose
  // `deleteMany` override only stamps `deletedAt`, while `findIdsByDataLakeTag` above reads with
  // `includeDeleted`. A soft delete therefore leaves every prior run's rows in that id list forever,
  // so the count logged above becomes an all-time total rather than this clear's work and the probe
  // lake accumulates tombstones on a shared stage. The measurement itself was never at risk - chunks
  // are hard-deleted and the search's scoped-file read is plugin-filtered, so a stale generation has
  // no chunks and is out of scope - but the log line was wrong and the growth was unbounded.
  for (const id of existingIds) {
    await fabFileRepository.hardDeleteOneById(id);
    await fabFileChunkRepository.deleteManyByFabFileId(id);
  }
}

/**
 * Backdate the OLD generation's `createdAt` through the NATIVE driver, which is the only thing that
 * actually bypasses the `timestamps: true` hook here (see the comment below), then READ IT BACK.
 * `fabFileRepository.create` cannot do this itself - its signature is `Omit<T, 'id' | 'updatedAt' | 'createdAt'>`
 * (`b4m-core/db-core/src/models/BaseModel.ts`), which exists specifically so Mongoose's own
 * timestamp hook stamps every normal write. Unverified in code review, so it is verified HERE,
 * at runtime, every run: if the write did not stick, the two generations are not actually
 * distinguishable by age and the whole comparison would be silently measuring nothing.
 */
async function backdateAndVerify(fabFileId: string, fileName: string): Promise<Date> {
  const backdatedAt = new Date(Date.now() - OLD_GENERATION_AGE_DAYS * 24 * 60 * 60 * 1000);
  // Native driver, NOT FabFile.updateOne({ timestamps: false }): the Mongoose option does not
  // suppress the timestamp hook here (verified against stage dev - the read-back below caught it
  // stamping createdAt to now). Going through .collection bypasses all Mongoose middleware, which
  // is the only reliable way to force an explicit createdAt on a `timestamps: true` schema.
  await FabFile.collection.updateOne(
    { _id: new FabFile.base.Types.ObjectId(fabFileId) },
    { $set: { createdAt: backdatedAt } }
  );

  const verifyDoc = await FabFile.findById(fabFileId).lean<{ createdAt?: Date } | null>();
  const persistedMs = verifyDoc?.createdAt ? new Date(verifyDoc.createdAt).getTime() : NaN;
  const driftMs = Number.isFinite(persistedMs) ? Math.abs(persistedMs - backdatedAt.getTime()) : Infinity;

  if (driftMs > 5_000) {
    throw new Error(
      `Backdating createdAt did NOT persist for FabFile ${fabFileId} ("${fileName}", OLD generation). ` +
        `Expected ~${backdatedAt.toISOString()}, read back ${verifyDoc?.createdAt ?? 'undefined'}. Refusing to ` +
        `continue: the OLD and NEW generations would not be distinguishable by age, and ` +
        `partitionBySupersession's "newest wins" rule (see supersession.ts) would then pick a winner at ` +
        `random rather than by generation - the measurement would be garbage, not a real comparison.`
    );
  }
  logger.log(`  backdated + verified: ${fileName} (OLD) createdAt = ${verifyDoc?.createdAt?.toString()}`);
  return backdatedAt;
}

type EmbeddingHandle = {
  embeddingModel: string;
  generateEmbedding: (text: string) => Promise<number[]>;
};

/** Mirrors ingest-help-datalake.ts's credential resolution exactly, for the probe user. */
async function resolveEmbeddingHandle(userId: string): Promise<EmbeddingHandle> {
  const embeddingModelRaw = await adminSettingsRepository.getSettingsValue('defaultEmbeddingModel');
  if (!embeddingModelRaw || !isSupportedEmbeddingModel(embeddingModelRaw)) {
    throw new Error(`defaultEmbeddingModel is unset or unsupported on this stage: ${String(embeddingModelRaw)}`);
  }
  const embeddingModel = embeddingModelRaw;

  const apiKeyTable = await apiKeyService.getEffectiveLLMApiKeys(userId, {
    db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
    getSettingsByNames,
  });
  const provider = getProviderFromModel(embeddingModel);
  const embeddingConfig: { openaiApiKey?: string | null; voyageApiKey?: string | null; ollamaBaseUrl?: string | null } =
    {};
  if (provider === 'openai') {
    embeddingConfig.openaiApiKey = apiKeyTable?.openai;
    if (!embeddingConfig.openaiApiKey) throw new Error(`No OpenAI API key resolved for user ${userId}.`);
  } else if (provider === 'voyageai') {
    embeddingConfig.voyageApiKey = apiKeyTable?.voyageai;
    if (!embeddingConfig.voyageApiKey) throw new Error(`No Voyage API key resolved for user ${userId}.`);
  } else if (provider === 'ollama') {
    embeddingConfig.ollamaBaseUrl = apiKeyTable?.ollama;
    if (!embeddingConfig.ollamaBaseUrl) throw new Error(`No Ollama base URL resolved for user ${userId}.`);
  }
  // Other providers (e.g. Bedrock) are keyless/IAM-based and need no credential here - same
  // guard as ingest-help-datalake.ts.
  const embeddingService = new EmbeddingFactory(embeddingConfig).createEmbeddingService(embeddingModel);
  return {
    embeddingModel,
    generateEmbedding: (text: string) => embeddingService.generateEmbedding(text),
  };
}

/** Rough token estimate (chars/4); parity with ingest-help-datalake.ts's heuristic. */
const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

async function seedOneGeneration(
  doc: ProbeDoc,
  generation: Generation,
  text: string,
  userId: string,
  embedding: EmbeddingHandle,
  docIndex: number
): Promise<SeededFile> {
  const vector = await embedding.generateEmbedding(text);
  const now = new Date();
  const chunkPayload: Omit<IFabFileChunkDocument, 'id'> = {
    fabFileId: '',
    text,
    tokenCount: estimateTokens(text),
    charLength: countCodePoints(text),
    vector,
    createdAt: now,
    updatedAt: now,
  };

  const fabFile = await fabFileRepository.create({
    userId,
    fileName: doc.fileName,
    fileSize: Buffer.byteLength(text),
    mimeType: 'text/plain',
    type: KnowledgeType.TEXT,
    tags: [
      { name: DATALAKE_TAG, strength: 1 },
      // Same content tag on both generations - a re-upload of the same document keeps the same
      // tag in real usage. Generation is tracked in-memory (SeededFile), never via a tag, so
      // attribution below cannot accidentally read this as the identity signal.
      { name: `${FILE_TAG_PREFIX}${docIndex}`, strength: 1 },
    ],
    primaryTag: DATALAKE_TAG,
    system: true,
    chunked: true,
    chunkCount: 1,
    chunkedCharCount: chunkPayload.charLength ?? 0,
    vectorized: true,
    vectorizedChunkCount: 1,
    embeddingModel: embedding.embeddingModel,
    status: 'complete',
    isGlobalRead: true,
    isGlobalWrite: false,
    users: [],
    groups: [],
  });

  await fabFileChunkRepository.bulkInsert([{ ...chunkPayload, fabFileId: fabFile.id }]);

  return { fabFileId: fabFile.id, fileName: doc.fileName, generation, docIndex };
}

async function seedCorpus(userId: string): Promise<SeededFile[]> {
  const embedding = await resolveEmbeddingHandle(userId);
  logger.log(`Embedding model: ${embedding.embeddingModel}`);

  const seeded: SeededFile[] = [];
  for (let docIndex = 0; docIndex < PROBE_DOCS.length; docIndex++) {
    const doc = PROBE_DOCS[docIndex];
    logger.log(`Seeding "${doc.fileName}"...`);
    // OLD first, NEW second, and backdate only once BOTH rows exist. The order is what makes the
    // measurement attributable: `winsOver` (supersession.ts) compares `createdAt` and falls back to
    // ASCENDING id on a tie, so whichever generation is inserted first also wins the tiebreaker.
    // Seeding OLD first therefore points the tiebreaker at OLD while the recency arm points at NEW,
    // so an observed "0 old / N new" is reachable ONLY through `createdAt`. Seeding NEW first would
    // aim both arms at NEW: if a refactor ever dropped `createdAt` from the rankable file (it is
    // threaded through `semanticDataLakeSearch`), every timestamp would read -Infinity, the tie
    // would fall to id, NEW would still win, and this probe would print the same pass it prints
    // today while measuring nothing. Backdating last preserves the original reason for NEW-first:
    // a failure partway through never leaves a backdated OLD with no NEW sibling to compare it to.
    const older = await seedOneGeneration(doc, 'OLD', doc.oldText, userId, embedding, docIndex);
    const newer = await seedOneGeneration(doc, 'NEW', doc.newText, userId, embedding, docIndex);
    // Assert the ordering rather than trust it: it is the entire load-bearing precondition of the
    // comment above, and a bson counter wrap or a backwards clock step between the two inserts would
    // hand OLD the LARGER id, silently re-aiming the tiebreaker at NEW and restoring exactly the
    // over-determined measurement the ordering exists to prevent. `backdateAndVerify` below already
    // sets the standard of verifying its own precondition at runtime; this is the same one line.
    if (!(older.fabFileId < newer.fabFileId)) {
      throw new Error(
        `Seeded OLD (${older.fabFileId}) does not sort BEFORE NEW (${newer.fabFileId}) for ` +
          `"${doc.fileName}". winsOver breaks a createdAt tie on the SMALLER id, so this ordering is what ` +
          `points the tiebreaker at OLD and keeps "0 old / N new" attributable to createdAt alone. Refusing ` +
          `to measure with both arms aimed at NEW.`
      );
    }
    await backdateAndVerify(older.fabFileId, doc.fileName);
    seeded.push(older, newer);
  }
  return seeded;
}

// ---------------------------------------------------------------------------
// Lake scope + credentials for semanticDataLakeSearch - resolved the same way the known-working
// callers do (apps/client/pages/api/data-lakes/semantic-search.ts), not invented here.
// ---------------------------------------------------------------------------

const SEARCH_TOP_K = 20;
const SEARCH_MIN_SCORE = 0;

type ProbeScope = {
  dataLakeTags: string[];
  dataLakeTagPrefixes: string[];
  lakeMemberships: ReturnType<typeof dataLakeService.lakeMembershipsFrom>;
  lakes: Parameters<typeof dataLakeService.semanticDataLakeSearch>[0]['lakes'];
};

/**
 * `getDynamicDataLakeAccess` is the core resolver both `resolveRetrievalLakeScope` (the semantic-
 * search route) and the chat tool's `resolveSessionLakeAccess` sit on top of - calling it directly
 * for the probe user reproduces the same lake scope those callers would get, without needing an
 * Express request to hang it off. `lakes` is passed straight through to `semanticDataLakeSearch`
 * as `AttributableLake[]`; `ResolvedLakeAccess` is a strict superset of that shape.
 */
async function resolveProbeScope(user: IUserDocument): Promise<ProbeScope> {
  const access = await dataLakeService.getDynamicDataLakeAccess({
    db: {
      dataLakes: dataLakeRepository,
      organizations: organizationRepository,
    },
    user: { id: user.id, tags: user.tags ?? [] },
  });
  const lakeMemberships = dataLakeService.lakeMembershipsFrom(access.lakes);
  dataLakeService.warnIfManyLakeMemberships(lakeMemberships, logger, 'supersession-probe');
  return {
    dataLakeTags: access.dataLakeTags,
    dataLakeTagPrefixes: access.dataLakeTagPrefixes,
    lakeMemberships,
    lakes: access.lakes,
  };
}

type ApiKeyTable = { openai?: string | null; voyageai?: string | null; ollama?: string | null };

/** Same shape semantic-search.ts builds: all three keys, not narrowed to the embedding model's own
 *  provider - semanticDataLakeSearch can embed an ALTERNATE model under a different provider. */
async function resolveApiKeyTable(userId: string): Promise<ApiKeyTable> {
  const effectiveKeys = await apiKeyService.getEffectiveLLMApiKeys(userId, {
    db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
    getSettingsByNames,
  });
  return {
    openai: effectiveKeys?.openai,
    voyageai: effectiveKeys?.voyageai,
    ollama: effectiveKeys?.ollama,
  };
}

// ---------------------------------------------------------------------------
// One query -> chunk-level attribution, via semanticDataLakeSearch directly.
// ---------------------------------------------------------------------------

type SupersessionSummary = {
  count: number;
  sample: { fileId: string; fileName?: string; tier: string; supersededBy: string }[];
};

type QueryResult = {
  docIndex: number;
  fileName: string;
  query: string;
  chunks: ChunkAttribution[];
  supersession: SupersessionSummary;
};

async function runQuery(
  doc: ProbeDoc,
  docIndex: number,
  user: IUserDocument,
  scope: ProbeScope,
  embeddingModel: SupportedEmbeddingModel,
  apiKeyTable: ApiKeyTable,
  byFabFileId: Map<string, SeededFile>,
  collapseEnabled: boolean
): Promise<QueryResult> {
  const search = await dataLakeService.semanticDataLakeSearch(
    {
      userId: user.id,
      userGroups: user.groups ?? [],
      query: doc.query,
      topK: SEARCH_TOP_K,
      minScore: SEARCH_MIN_SCORE,
      embeddingModel,
      apiKeyTable,
      dataLakeTags: scope.dataLakeTags,
      dataLakeTagPrefixes: scope.dataLakeTagPrefixes,
      lakeMemberships: scope.lakeMemberships,
      lakes: scope.lakes,
      supersessionCollapseEnabled: collapseEnabled,
      logger,
    },
    {
      db: { fabfiles: fabFileRepository, fabfilechunks: fabFileChunkRepository },
    }
  );

  const context = `collapse=${collapseEnabled ? 'on' : 'off'} query "${doc.query}"`;
  const chunks: ChunkAttribution[] = attributeChunks(search.results, byFabFileId);
  assertAllAttributed(chunks, context);

  const supersession: SupersessionSummary = {
    count: search.supersession.count,
    sample: search.supersession.sample.map(s => ({
      fileId: s.fileId,
      fileName: s.fileName,
      tier: s.tier,
      supersededBy: s.supersededBy,
    })),
  };
  // The second output needs its own guard. The chunk guard above sees only what was SERVED, and a
  // superseded file is suppressed before ranking by definition, so foreign content can inflate the
  // count below without ever showing up in a result row.
  assertSupersessionSampleAttributed(supersession.sample, byFabFileId, context);

  return { docIndex, fileName: doc.fileName, query: doc.query, chunks, supersession };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

type ConfigRun = {
  collapseEnabled: boolean;
  queries: QueryResult[];
};

function printConfigTable(run: ConfigRun): { oldCount: number; newCount: number; supersededCount: number } {
  logger.log(`\n--- collapse=${run.collapseEnabled ? 'on' : 'off'} ---`);
  logger.log(['docIndex', 'fileName', 'generation', 'score', 'fabFileId', 'chunkId'].join('  |  '));
  for (const q of run.queries) {
    if (q.chunks.length === 0) {
      logger.log(`  (query "${q.query}" -> no chunks served)`);
    }
    for (const c of q.chunks) {
      logger.log(
        [String(q.docIndex), c.fileName, c.generation, c.score.toFixed(4), c.fabFileId, c.chunkId].join('  |  ')
      );
    }
  }
  // `runQuery` has already refused any UNKNOWN chunk, so oldCount + newCount is the full total.
  const { oldCount, newCount } = tallyGenerations(run.queries.flatMap(q => q.chunks));
  // Chunks accumulate across queries; the superseded report does NOT - it is built once from the
  // scoped file set before ranking, so every query returns the same one. See `supersededCountFor`.
  // Reported here, once, rather than inside the loop above: printing it per query labelled the same
  // corpus-wide constant as `doc 0`, `doc 1`, `doc 2`, which reads as three separate suppressions.
  const supersededCount = supersededCountFor(run.queries, `collapse=${run.collapseEnabled ? 'on' : 'off'}`);
  if (supersededCount > 0) {
    logger.log(
      `  supersession: ${supersededCount} file(s) suppressed for this configuration - ` +
        run.queries[0].supersession.sample
          .map(s => `${s.fileName ?? s.fileId} (tier=${s.tier}, kept ${s.supersededBy})`)
          .join('; ')
    );
  }
  logger.log(
    `collapse=${run.collapseEnabled ? 'on ' : 'off'}  ${oldCount + newCount} chunks: ${oldCount} old / ${newCount} new` +
      `  (${supersededCount} superseded)`
  );
  return { oldCount, newCount, supersededCount };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function runOneConfig(
  collapseEnabled: boolean,
  user: IUserDocument,
  scope: ProbeScope,
  embeddingModel: SupportedEmbeddingModel,
  apiKeyTable: ApiKeyTable,
  byFabFileId: Map<string, SeededFile>
): Promise<ConfigRun> {
  await writeSetting(COLLAPSE_SETTING, String(collapseEnabled));

  // Read the setting back through the product's OWN accessor (not the raw row) and assert it
  // matches what was just written. This is what preserves the claim that the flag read is wired to
  // behavior, now that the boolean is passed to semanticDataLakeSearch explicitly rather than read
  // by the tool itself - a caching or wiring regression must fail loudly here, not measure silently.
  const readBack = await readCollapseSettingAsBoolean();
  if (readBack !== collapseEnabled) {
    throw new Error(
      `Wrote ${COLLAPSE_SETTING}=${collapseEnabled} but adminSettingsRepository.getSettingsValue read back ` +
        `${String(readBack)}. The setting is not wired the way this probe assumes - refusing to measure this ` +
        `configuration.`
    );
  }

  const queries: QueryResult[] = [];
  for (let docIndex = 0; docIndex < PROBE_DOCS.length; docIndex++) {
    queries.push(
      await runQuery(PROBE_DOCS[docIndex], docIndex, user, scope, embeddingModel, apiKeyTable, byFabFileId, readBack)
    );
  }

  const totalChunks = queries.reduce((sum, q) => sum + q.chunks.length, 0);
  if (totalChunks === 0) {
    throw new Error(
      `collapse=${collapseEnabled} returned ZERO chunks across all ${queries.length} queries. That is not a ` +
        `valid "collapse suppressed everything" result - minScore is ${SEARCH_MIN_SCORE} and topK is ` +
        `${SEARCH_TOP_K}, so an empty result means the corpus or lake scope is wrong (dataLakeTags: ` +
        `${scope.dataLakeTags.join(', ') || '(none)'}), not that collapse worked. Refusing to report a ` +
        `zero-vs-zero comparison as a pass.`
    );
  }

  return { collapseEnabled, queries };
}

/**
 * The measurement itself. Runs entirely under the settings lease its caller holds - see `main`.
 */
async function runProbe(): Promise<void> {
  const user = await findOrCreateProbeUser();
  await findOrCreateProbeLake(user.id);
  await clearPreviousRun();

  const seeded = await seedCorpus(user.id);
  const byFabFileId = new Map<string, SeededFile>(seeded.map(f => [f.fabFileId, f]));
  logger.log(`Seeded ${seeded.length} FabFiles (${PROBE_DOCS.length} documents x 2 generations).`);

  const embeddingModelRaw = await adminSettingsRepository.getSettingsValue('defaultEmbeddingModel');
  if (!embeddingModelRaw || !isSupportedEmbeddingModel(embeddingModelRaw)) {
    throw new Error(`defaultEmbeddingModel is unset or unsupported on this stage: ${String(embeddingModelRaw)}`);
  }
  const embeddingModel = embeddingModelRaw;
  const apiKeyTable = await resolveApiKeyTable(user.id);
  const scope = await resolveProbeScope(user);
  if (scope.dataLakeTags.length === 0) {
    throw new Error(
      `Probe user ${user.id} resolves to zero accessible data lakes (getDynamicDataLakeAccess returned an ` +
        `empty dataLakeTags). The probe lake "${LAKE_SLUG}" should be owner-reachable regardless of gating - ` +
        `check that dataLakeRepository.create persisted createdByUserId correctly.`
    );
  }
  logger.log(`Lake scope: dataLakeTags=[${scope.dataLakeTags.join(', ')}], embeddingModel=${embeddingModel}`);

  const offRun = await runOneConfig(false, user, scope, embeddingModel, apiKeyTable, byFabFileId);
  const offSummary = printConfigTable(offRun);

  const onRun = await runOneConfig(true, user, scope, embeddingModel, apiKeyTable, byFabFileId);
  const onSummary = printConfigTable(onRun);

  logger.log('\n=== Summary ===');
  logger.log(
    `collapse=off  ${offSummary.oldCount + offSummary.newCount} chunks: ${offSummary.oldCount} old / ` +
      `${offSummary.newCount} new  (${offSummary.supersededCount} superseded)`
  );
  logger.log(
    `collapse=on   ${onSummary.oldCount + onSummary.newCount} chunks: ${onSummary.oldCount} old / ` +
      `${onSummary.newCount} new  (${onSummary.supersededCount} superseded)`
  );

  const results = { off: offRun, on: onRun };
  const summary = { off: offSummary, on: onSummary };

  const outDir = path.resolve(SCRIPTS_PACKAGE_DIR, 'out');
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'supersession-probe.json');
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        lakeSlug: LAKE_SLUG,
        probeUserId: user.id,
        embeddingModel,
        seededFiles: seeded,
        results,
        summary,
      },
      null,
      2
    )
  );
  logger.log(`Wrote ${outPath}`);
}

async function main(): Promise<void> {
  await connectDB(Resource.MONGODB_URI.value.replace('%STAGE%', Resource.App.stage));
  logger.log(`Connected (stage: ${Resource.App.stage})`);

  // Lease BEFORE any of the run, not just before the setting writes. `clearPreviousRun` deletes
  // every FabFile carrying this probe's datalake tag and `seedCorpus` spends live embedding calls
  // recreating them, so a second run that only took the lease later would wipe an in-flight run's
  // corpus out from under it and refuse to start afterwards. The in-flight run's collapse=on pass
  // would then be querying the intruder's FabFiles, attribute none of them, and print a
  // clean-looking "0 old" - a stronger-looking version of the result the probe is trying to
  // demonstrate, which is the direction a failure must never fall. recall-probe.ts can afford to
  // acquire late because it only READS an existing lake; this script mutates shared corpus state,
  // so the lease has to cover the whole run.
  const { originalValue, restore } = await acquireCollapseSettingLease();
  logger.log(`Leased ${COLLAPSE_SETTING} (was ${originalValue === null ? '(unset)' : originalValue}).`);

  try {
    await runProbe();
  } finally {
    await restore();
  }
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
