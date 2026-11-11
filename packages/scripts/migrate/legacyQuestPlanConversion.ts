import { createHash } from 'node:crypto';
import pLimit from 'p-limit';
import { Types } from 'mongoose';
import {
  FAB_FILE_CONTENT_REWRITE_PATCH,
  FabFileSourceType,
  KnowledgeType,
  questGraphToMarkdown,
  questPlanToMarkdown,
  type IQuestGraph,
  type IQuestMasterPlanDocument,
  type IQuestNode,
} from '@bike4mind/common';
import {
  adminSettingsRepository,
  dataLakeRepository,
  FabFile,
  fabFileRepository,
  mongoose,
  organizationRepository,
  scopedSettingsRepository,
  Session,
  User,
  userRepository,
} from '@bike4mind/database';
import { fabFilesService } from '@bike4mind/services';

/**
 * Converts each live, non-empty legacy QuestMaster plan (v4, `questmasterplans`) and graph (v5,
 * `questgraphs` + `questnodes`) into one markdown file owned by its owner alone, outside the storage
 * quota. Safe to re-run: files are keyed by (owner, source id), refreshed in place when the source
 * changed, and never resurrected once the user deletes them. The legacy rows are only read.
 *
 * Raw driver for the legacy collections, never their model classes: those models are deleted once
 * the legacy feature is removed, and this module has to outlive them for the final re-run.
 */

// Under the migrator Lambda's 15-minute timeout, leaving room for the steps that run after `up()`.
// Counts from the start of the migrator run (earlier migrations share the Lambda), so callers pass
// `deadline = startedAt + DEFAULT_RUN_MS`.
export const DEFAULT_RUN_MS = 12 * 60 * 1000;
const BATCH_SIZE = 200;
const CONCURRENCY = 8;
const MAX_SAMPLES = 20;
const ARCHIVE_TAG = 'questmaster-archive';
const ARCHIVE_FOLDER = 'Questmaster archive';

export type ArchiveStorage = Parameters<typeof fabFilesService.createFabFile>[2]['storage'] & {
  /** Replaces the bytes at an existing key. */
  overwrite: (path: string, content: string, options: { ContentType: string; ContentLength: number }) => Promise<void>;
};

export interface ConversionLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

/** What the source walk itself counts, before a source reaches the conversion or the check. */
export interface SourceCounts {
  live: number;
  skippedEmpty: number;
  skippedNoOwner: number;
}

export interface ConversionCounts extends SourceCounts {
  created: number;
  refreshed: number;
  unchanged: number;
  skippedUserDeleted: number;
  skippedUserEdited: number;
  failed: number;
  failedSamples: string[];
}

const emptyCounts = (): ConversionCounts => ({
  live: 0,
  created: 0,
  refreshed: 0,
  unchanged: 0,
  skippedEmpty: 0,
  skippedNoOwner: 0,
  skippedUserDeleted: 0,
  skippedUserEdited: 0,
  failed: 0,
  failedSamples: [],
});

type SourceKind = 'quest-plan' | 'quest-graph';

interface Item {
  id: string;
  kind: SourceKind;
  ownerId: string;
  goal: string;
  updatedAt: Date;
  render: (exportedOn: string) => string;
}

// The date is the only part of the body that changes between runs of an unchanged source.
const fingerprint = (item: Item): string => createHash('sha256').update(item.render('1970-01-01')).digest('hex');

type RawDoc = Record<string, unknown> & { _id: Types.ObjectId };

// Plain-ASCII file name from the goal; the goal itself is a free-text heading inside the file.
const fileNameFor = (goal: string, id: string): string => {
  const slug = goal
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'plan'}-${id.slice(-6)}.md`;
};

const asDate = (value: unknown): Date => {
  const d = value instanceof Date ? value : new Date(value as string);
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
};

type Db = NonNullable<typeof mongoose.connection.db>;

const connectedDb = (): Db => {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Database connection not established');
  return db;
};

const archiveKey = (item: Pick<Item, 'ownerId' | 'id'>): string => `${item.ownerId}:${item.id}`;

// One lookup per page. Includes soft-deleted rows so a file the user deleted is not recreated.
const archiveFilesByKey = async (items: Item[]) => {
  const existing = await FabFile.find(
    {
      userId: { $in: [...new Set(items.map(i => i.ownerId))] },
      sourceType: FabFileSourceType.QUESTMASTER_ARCHIVE,
      'sourceMetadata.sourceId': { $in: items.map(i => i.id) },
    },
    null,
    { includeDeleted: true }
  ).lean();
  return new Map(existing.map(f => [`${f.userId}:${f.sourceMetadata?.sourceId}`, f]));
};

// A size that no longer matches what was written, or a charge stamp (only a user rewrite sets one
// on an exempt row), means the user rewrote the file.
const isUserRewritten = (file: {
  fileSize?: number | null;
  storageChargedAt?: unknown;
  sourceMetadata?: Record<string, unknown> | null;
}): boolean => file.fileSize !== file.sourceMetadata?.generatedBytes || file.storageChargedAt != null;

export async function convertLegacyQuestPlans(deps: {
  storage: ArchiveStorage;
  logger: ConversionLogger;
  now: Date;
  batchSize?: number;
  /** Stop taking new pages once passed; whatever is left is picked up by the next run. */
  deadline?: Date;
}): Promise<{ plans: ConversionCounts; graphs: ConversionCounts; stoppedEarly: boolean }> {
  const { storage, logger, now } = deps;
  const batchSize = deps.batchSize ?? BATCH_SIZE;
  const deadline = (deps.deadline ?? new Date(Date.now() + DEFAULT_RUN_MS)).getTime();
  const db = connectedDb();

  const exportedOn = now.toISOString().slice(0, 10);
  const limit = pLimit(CONCURRENCY);

  const fabDb = {
    fabFiles: fabFileRepository,
    adminSettings: adminSettingsRepository,
    scopedSettings: scopedSettingsRepository,
    users: userRepository,
    organizations: organizationRepository,
    dataLakes: dataLakeRepository,
  };

  const processItems = async (items: Item[], counts: ConversionCounts) => {
    if (items.length === 0) return;
    const existingByKey = await archiveFilesByKey(items);

    await Promise.all(
      items.map(item =>
        limit(async () => {
          try {
            const file = existingByKey.get(archiveKey(item));
            const sourceUpdatedAt = item.updatedAt.toISOString();
            const content = () => item.render(exportedOn);

            if (!file) {
              const body = content();
              const fileSize = Buffer.byteLength(body);
              await fabFilesService.createFabFile(
                item.ownerId,
                {
                  fileName: fileNameFor(item.goal, item.id),
                  mimeType: 'text/markdown',
                  contentType: 'text/markdown',
                  content: body,
                  fileSize,
                  type: KnowledgeType.FILE,
                  tags: [{ name: ARCHIVE_TAG, strength: 1 }],
                  relativePath: `${ARCHIVE_FOLDER}/${fileNameFor(item.goal, item.id)}`,
                },
                {
                  db: fabDb,
                  storage,
                  provenance: {
                    sourceType: FabFileSourceType.QUESTMASTER_ARCHIVE,
                    sourceMetadata: {
                      sourceKind: item.kind,
                      sourceId: item.id,
                      sourceUpdatedAt,
                      generatedBytes: fileSize,
                      contentHash: fingerprint(item),
                    },
                  },
                  storageExempt: true,
                }
              );
              counts.created++;
              return;
            }

            if (file.deletedAt) {
              counts.skippedUserDeleted++;
              return;
            }
            if (file.sourceMetadata?.sourceUpdatedAt === sourceUpdatedAt) {
              counts.unchanged++;
              return;
            }
            if (isUserRewritten(file)) {
              counts.skippedUserEdited++;
              return;
            }
            // Only `updatedAt` moved (e.g. the plan was opened): keep the file and its derived data.
            const contentHash = fingerprint(item);
            if (file.sourceMetadata?.contentHash === contentHash) {
              await FabFile.updateOne(
                { _id: file._id },
                { $set: { 'sourceMetadata.sourceUpdatedAt': sourceUpdatedAt } }
              );
              counts.unchanged++;
              return;
            }
            const body = content();
            const fileSize = Buffer.byteLength(body);
            await storage.overwrite(file.filePath as string, body, {
              ContentType: 'text/markdown',
              ContentLength: fileSize,
            });
            await FabFile.updateOne(
              { _id: file._id },
              {
                $set: {
                  ...FAB_FILE_CONTENT_REWRITE_PATCH,
                  fileSize,
                  'sourceMetadata.sourceUpdatedAt': sourceUpdatedAt,
                  'sourceMetadata.generatedBytes': fileSize,
                  'sourceMetadata.contentHash': contentHash,
                },
              }
            );
            counts.refreshed++;
          } catch (error) {
            counts.failed++;
            if (counts.failedSamples.length < MAX_SAMPLES) counts.failedSamples.push(item.id);
            logger.warn(`Quest archive conversion failed for ${item.kind} ${item.id}: ${(error as Error).message}`);
          }
        })
      )
    );
  };

  const plans = emptyCounts();
  const graphs = emptyCounts();
  const { stoppedEarly, noOwner } = await walkLegacySources({
    db,
    logger,
    batchSize,
    deadline,
    plans,
    graphs,
    onItems: processItems,
  });

  logger.info(`Quest plan conversion (v4 plans): ${JSON.stringify(plans)}`);
  if (noOwner.length) logger.warn(`Plans with no resolvable owner (sample): ${noOwner.join(', ')}`);
  logger.info(`Quest plan conversion (v5 graphs): ${JSON.stringify(graphs)}`);
  return { plans, graphs, stoppedEarly };
}

/**
 * Pages through every live legacy plan and graph, resolves each owner, and hands the non-empty,
 * owned ones to `onItems`. Shared by the conversion and the coverage check so both agree on which
 * sources count.
 */
async function walkLegacySources<C extends SourceCounts>(opts: {
  db: Db;
  logger: ConversionLogger;
  batchSize: number;
  /** Epoch ms. */
  deadline: number;
  plans: C;
  graphs: C;
  onItems: (items: Item[], counts: C) => Promise<void>;
}): Promise<{ stoppedEarly: boolean; noOwner: string[] }> {
  const { db, logger, batchSize, deadline, plans, graphs, onItems } = opts;
  let stoppedEarly = false;
  // One query per page: the ids that name a live account (a non-ObjectId never does).
  const existingUsers = async (ids: string[]): Promise<Set<string>> => {
    const valid = [...new Set(ids)].filter(id => Types.ObjectId.isValid(id));
    if (valid.length === 0) return new Set();
    const found = await db
      .collection(User.collection.name)
      .find({ _id: { $in: valid.map(id => new Types.ObjectId(id)) } })
      .project({ _id: 1 })
      .toArray();
    return new Set(found.map(u => String(u._id)));
  };

  const paginate = async (collection: string, handle: (page: RawDoc[]) => Promise<void>) => {
    if (stoppedEarly) return;
    let lastId: Types.ObjectId | null = null;
    for (;;) {
      const page = (await db
        .collection(collection)
        .find({ deletedAt: null, ...(lastId ? { _id: { $gt: lastId } } : {}) })
        .sort({ _id: 1 })
        .limit(batchSize)
        .toArray()) as RawDoc[];
      if (page.length === 0) return;
      await handle(page);
      lastId = page[page.length - 1]._id;
      if (Date.now() > deadline) {
        stoppedEarly = true;
        const remaining = await db.collection(collection).countDocuments({ deletedAt: null, _id: { $gt: lastId } });
        logger.warn(`Quest plan conversion ran out of time in ${collection}; ${remaining} sources left unvisited`);
        return;
      }
    }
  };

  // v4 plans
  const noOwner: string[] = [];
  await paginate('questmasterplans', async page => {
    plans.live += page.length;
    const notebookIds = page.filter(p => !p.userId).map(p => p.notebookId as string);
    const notebookOwner = new Map<string, string>();
    if (notebookIds.length) {
      const sessions = await db
        .collection(Session.collection.name)
        .find({ _id: { $in: notebookIds.filter(Types.ObjectId.isValid).map(id => new Types.ObjectId(id)) } })
        .project({ userId: 1 })
        .toArray();
      for (const s of sessions) if (s.userId) notebookOwner.set(String(s._id), String(s.userId));
    }

    const liveOwners = await existingUsers(
      page.map(p => (p.userId ? String(p.userId) : (notebookOwner.get(String(p.notebookId)) ?? '')))
    );

    const items: Item[] = [];
    for (const raw of page) {
      const id = String(raw._id);
      const quests = (raw.quests as { subQuests?: unknown[] }[] | undefined) ?? [];
      if (!quests.some(q => (q.subQuests?.length ?? 0) > 0)) {
        plans.skippedEmpty++;
        continue;
      }
      const ownerId = raw.userId ? String(raw.userId) : notebookOwner.get(String(raw.notebookId));
      if (!ownerId || !liveOwners.has(ownerId)) {
        plans.skippedNoOwner++;
        if (noOwner.length < MAX_SAMPLES) noOwner.push(id);
        continue;
      }
      const plan = { ...raw, id } as unknown as IQuestMasterPlanDocument;
      items.push({
        id,
        kind: 'quest-plan',
        ownerId,
        goal: String(raw.goal ?? ''),
        updatedAt: asDate(raw.updatedAt),
        render: exportedOn => questPlanToMarkdown(plan, { exportedOn, frontMatter: true }),
      });
    }
    await onItems(items, plans);
  });

  // v5 graphs
  await paginate('questgraphs', async page => {
    graphs.live += page.length;
    const nodeDocs = await db
      .collection('questnodes')
      .find({ graphId: { $in: page.map(g => String(g._id)) }, deletedAt: null })
      .sort({ order: 1, _id: 1 })
      .toArray();
    const nodesByGraph = new Map<string, IQuestNode[]>();
    for (const n of nodeDocs) {
      const list = nodesByGraph.get(String(n.graphId)) ?? [];
      list.push({ ...n, id: String(n._id) } as unknown as IQuestNode);
      nodesByGraph.set(String(n.graphId), list);
    }

    const liveOwners = await existingUsers(page.map(g => (g.userId ? String(g.userId) : '')));

    const items: Item[] = [];
    for (const raw of page) {
      const id = String(raw._id);
      const nodes = nodesByGraph.get(id) ?? [];
      if (nodes.length === 0) {
        graphs.skippedEmpty++;
        continue;
      }
      if (!raw.userId || !liveOwners.has(String(raw.userId))) {
        graphs.skippedNoOwner++;
        continue;
      }
      const graph = { ...raw, id } as unknown as IQuestGraph;
      items.push({
        id,
        kind: 'quest-graph',
        ownerId: String(raw.userId),
        goal: String(raw.goal ?? ''),
        // A node edit does not touch the graph row, so the newest node counts as a source change.
        updatedAt: new Date(
          Math.max(asDate(raw.updatedAt).getTime(), ...nodes.map(n => asDate(n.updatedAt).getTime()))
        ),
        render: exportedOn => questGraphToMarkdown(graph, nodes, { exportedOn, frontMatter: true }),
      });
    }
    await onItems(items, graphs);
  });

  return { stoppedEarly, noOwner };
}

export interface CoverageCounts extends SourceCounts {
  /** Non-empty sources with a live owner: each must have a file. */
  expected: number;
  /** Sources whose file is accounted for: `current + userDeleted + userEdited`. */
  files: number;
  current: number;
  userDeleted: number;
  userEdited: number;
  missing: number;
  stale: number;
  uncoveredSamples: string[];
}

const emptyCoverage = (): CoverageCounts => ({
  live: 0,
  skippedEmpty: 0,
  skippedNoOwner: 0,
  expected: 0,
  files: 0,
  current: 0,
  userDeleted: 0,
  userEdited: 0,
  missing: 0,
  stale: 0,
  uncoveredSamples: [],
});

/**
 * Read-only check that every non-empty, owned legacy plan and graph has a file matching its current
 * state. A file the user deleted or rewrote counts as covered: it is theirs now, and the conversion
 * leaves it alone for the same reason. `covered` is false if any source is missing a file, has a
 * stale one, or the walk stopped before visiting everything.
 */
export async function verifyLegacyQuestPlanCoverage(deps: {
  logger: ConversionLogger;
  batchSize?: number;
  deadline?: Date;
}): Promise<{ plans: CoverageCounts; graphs: CoverageCounts; stoppedEarly: boolean; covered: boolean }> {
  const { logger } = deps;

  const check = async (items: Item[], counts: CoverageCounts) => {
    if (items.length === 0) return;
    counts.expected += items.length;
    const existingByKey = await archiveFilesByKey(items);
    for (const item of items) {
      const file = existingByKey.get(archiveKey(item));
      if (file?.deletedAt) counts.userDeleted++;
      else if (file?.sourceMetadata?.sourceUpdatedAt === item.updatedAt.toISOString()) counts.current++;
      else if (file && isUserRewritten(file)) counts.userEdited++;
      else {
        if (file) counts.stale++;
        else counts.missing++;
        if (counts.uncoveredSamples.length < MAX_SAMPLES) counts.uncoveredSamples.push(item.id);
      }
    }
    counts.files = counts.current + counts.userDeleted + counts.userEdited;
  };

  const plans = emptyCoverage();
  const graphs = emptyCoverage();
  const { stoppedEarly } = await walkLegacySources({
    db: connectedDb(),
    logger,
    batchSize: deps.batchSize ?? BATCH_SIZE,
    deadline: (deps.deadline ?? new Date(Date.now() + DEFAULT_RUN_MS)).getTime(),
    plans,
    graphs,
    onItems: check,
  });

  logger.info(`Quest plan coverage (v4 plans): ${JSON.stringify(plans)}`);
  logger.info(`Quest plan coverage (v5 graphs): ${JSON.stringify(graphs)}`);
  const covered = !stoppedEarly && plans.files === plans.expected && graphs.files === graphs.expected;
  return { plans, graphs, stoppedEarly, covered };
}
