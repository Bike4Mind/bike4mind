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
const DEFAULT_RUN_MS = 12 * 60 * 1000;
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

export interface ConversionCounts {
  live: number;
  created: number;
  refreshed: number;
  unchanged: number;
  skippedEmpty: number;
  skippedNoOwner: number;
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
  const db = mongoose.connection.db;
  if (!db) throw new Error('Database connection not established');

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
    // One lookup per page. Includes soft-deleted rows so a file the user deleted is not recreated.
    const existing = await FabFile.find(
      {
        userId: { $in: [...new Set(items.map(i => i.ownerId))] },
        sourceType: FabFileSourceType.QUESTMASTER_ARCHIVE,
        'sourceMetadata.sourceId': { $in: items.map(i => i.id) },
      },
      null,
      { includeDeleted: true }
    ).lean();
    const existingByKey = new Map(existing.map(f => [`${f.userId}:${f.sourceMetadata?.sourceId}`, f]));

    await Promise.all(
      items.map(item =>
        limit(async () => {
          try {
            const file = existingByKey.get(`${item.ownerId}:${item.id}`);
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
            // A size that no longer matches what was written, or a charge stamp (only a user rewrite
            // sets one on an exempt row), means the user rewrote the file.
            if (file.fileSize !== file.sourceMetadata?.generatedBytes || file.storageChargedAt != null) {
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

  let stoppedEarly = false;
  // One query per page: ids that name no live account (deleted, or not an ObjectId).
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

  const plans = emptyCounts();
  const graphs = emptyCounts();

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
    await processItems(items, plans);
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
    await processItems(items, graphs);
  });

  logger.info(`Quest plan conversion (v4 plans): ${JSON.stringify(plans)}`);
  if (noOwner.length) logger.warn(`Plans with no resolvable owner (sample): ${noOwner.join(', ')}`);
  logger.info(`Quest plan conversion (v5 graphs): ${JSON.stringify(graphs)}`);
  return { plans, graphs, stoppedEarly };
}
