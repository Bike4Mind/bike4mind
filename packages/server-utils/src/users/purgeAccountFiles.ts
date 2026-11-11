import { type IFabFileDocument } from '@bike4mind/common';
import {
  AppFile,
  FabFile,
  DataLakeModel,
  Organization,
  fabFileChunkRepository,
  fabFileRepository,
  importHistoryJobRepository,
  mongoose,
} from '@bike4mind/database';
import { selfHostOpenSearchEnabled } from '@bike4mind/db-core';
import { FabFileChunkSearchIndex, S3Storage } from '@bike4mind/fab-pipeline';
import { dataLakeService, fabFilesService } from '@bike4mind/services';
import type { Logger } from '@bike4mind/observability';
import { getAppFilesStorage, getFilesStorage, getGeneratedImageStorage } from '../utils/storage/index';
import { getGeneratedCopyStore } from '../files/generatedCopyStore';
import {
  type CdnInvalidationBatch,
  appFileCdnPath,
  createCdnInvalidationBatch,
  generatedCdnPath,
} from '../services/cdn/invalidateRouterCdn';
import { NOTEBOOK_DOWNLOAD_KEY_PREFIX } from '../notebooks/downloadCopyKeys';
import { Resource } from 'sst';
import { z } from 'zod';

const hasPrefixTag = (file: IFabFileDocument) => (file.tags ?? []).some(tag => tag?.name?.includes(':'));

type PurgeOptions = { logger: Pick<Logger, 'info' | 'warn' | 'error'>; assertLease: () => Promise<void> };
const BATCH_SIZE = 50;

/**
 * Preserve legacy org uploads which predate the organizationId ownership stamp. Also decides what
 * the data subject export treats as a personal file (`server/dataSubject/subjectRecordExport.ts`).
 */
export async function isOrganizationFile(file: IFabFileDocument, userId: string): Promise<boolean> {
  return (await findOrganizationFileIds([file], userId)).has(file.id);
}

type LakeLookup = Parameters<typeof dataLakeService.findMemberLakesForFile>[1];
type MemberLake = Awaited<ReturnType<typeof dataLakeService.findMemberLakesForFile>>[number];

const findLakes = async (filter: Parameters<LakeLookup['find']>[0]): Promise<MemberLake[]> =>
  (await DataLakeModel.find(filter).setOptions({ includeDeleted: true })).map(lake => lake.toObject());

/**
 * The ids of the files an organization keeps (`isOrganizationFile`), with the lakes and personal
 * workspaces the whole batch needs read up front instead of up to three queries per file.
 */
export async function findOrganizationFileIds(
  files: readonly IFabFileDocument[],
  userId: string
): Promise<Set<string>> {
  const unowned = files.filter(file => !file.organizationId);
  const rawTags = unowned.flatMap(file => (file.tags ?? []).flatMap(tag => (tag?.name ? [tag.name] : [])));
  // Meta tags are looked up lowercased (`findMemberLakesForFile`), so both forms are prefetched.
  const tagNames = [...new Set(rawTags.flatMap(name => [name, name.toLowerCase()]))];
  const uploaders = [...new Set(unowned.filter(hasPrefixTag).map(file => file.userId))];
  const [tagged, owned] = await Promise.all([
    tagNames.length > 0 ? findLakes({ datalakeTag: { $in: tagNames } }) : [],
    uploaders.length > 0 ? findLakes({ createdByUserId: { $in: uploaders } }) : [],
  ]);
  const byTag = new Map<string, MemberLake>();
  for (const lake of tagged) if (lake.datalakeTag && !byTag.has(lake.datalakeTag)) byTag.set(lake.datalakeTag, lake);
  const byCreator = new Map<string, MemberLake[]>();
  for (const lake of owned) {
    const creator = String(lake.createdByUserId);
    byCreator.set(creator, [...(byCreator.get(creator) ?? []), lake]);
  }
  const prefetchedTags = new Set(tagNames);
  // Anything the prefetch did not cover is read as before, so a change to the member-lake rule
  // costs queries rather than misclassifying a file.
  const prefetched: LakeLookup = {
    find: async filter => {
      const { createdByUserId, ...rest } = filter as { createdByUserId?: unknown };
      if (typeof createdByUserId !== 'string' || Object.keys(rest).length > 0 || !uploaders.includes(createdByUserId)) {
        return findLakes(filter);
      }
      return byCreator.get(createdByUserId) ?? [];
    },
    findByDatalakeTag: async datalakeTag => {
      if (prefetchedTags.has(datalakeTag)) return byTag.get(datalakeTag) ?? null;
      const lake = await DataLakeModel.findOne({ datalakeTag }).setOptions({ includeDeleted: true });
      return lake?.toObject() ?? null;
    },
  };

  const owners = new Map<string, string>();
  for (const file of files) {
    const organizationId =
      file.organizationId ||
      fabFilesService.pickOwnerOrganizationId(
        await dataLakeService.findMemberLakesForFile(file, prefetched),
        file.sourceLakeId
      );
    if (organizationId) owners.set(file.id, organizationId);
  }
  // An id that is not an ObjectId names no workspace, so it can only be an organization's.
  const workspaceIds = [...new Set(owners.values())].filter(id => mongoose.isObjectIdOrHexString(id));
  // A personal workspace is owned by this account and is removed by the purge's final
  // transaction. Its files must go too; genuine organizations retain their own content.
  const personalWorkspaces =
    workspaceIds.length === 0
      ? []
      : await Organization.find({ _id: { $in: workspaceIds }, userId, personal: true })
          .setOptions({ includeDeleted: true })
          .select('_id');
  const personal = new Set(personalWorkspaces.map(workspace => String(workspace._id)));
  return new Set([...owners].filter(([, organizationId]) => !personal.has(organizationId)).map(([id]) => id));
}

async function purgeFile(
  file: IFabFileDocument,
  { logger, assertLease }: PurgeOptions,
  cdn: CdnInvalidationBatch
): Promise<void> {
  const storage = getFilesStorage();
  const generated = getGeneratedCopyStore();
  const files = {
    delete: async (key: string) => {
      await assertLease();
      // Imports and copied rows can point at the same object. The last surviving row owns
      // deletion, including when the other reference is a tombstone or an org-owned file.
      const other = await FabFile.findOne({
        _id: { $ne: file.id },
        $or: [{ filePath: key }, { 'versions.filePath': key }],
      })
        .setOptions({ includeDeleted: true })
        .select('_id');
      if (!other) await storage.deletePermanently(key);
    },
  };
  // The ordinary delete helper treats revision failures as best-effort. A purge must keep
  // the row as its retry locator until every retained revision has been removed.
  const versions = new Set((file.versions ?? []).map(version => version.filePath));
  for (const key of versions) {
    if (key && key !== file.filePath) await files.delete(key);
  }
  await fabFilesService.deleteStoredObjects(
    [
      {
        id: file.id,
        filePath: file.filePath,
        sourceMetadata: file.sourceMetadata,
        moderationStatus: file.moderationStatus,
        blockReason: file.blockReason,
        versions: [],
      },
    ],
    {
      files,
      generated: {
        ...generated,
        storage: {
          delete: async key => {
            await assertLease();
            const other = await FabFile.findOne({
              _id: { $ne: file.id },
              'sourceMetadata.generatedCopyKey': key,
            })
              .setOptions({ includeDeleted: true })
              .select('_id');
            if (!other) {
              await getGeneratedImageStorage().deletePermanently(key);
              cdn.add(generatedCdnPath(key));
            }
          },
        },
      },
    },
    logger
  );
  if (selfHostOpenSearchEnabled()) {
    const models = await fabFileChunkRepository.distinctRetrievalIndexModelsByFabFileIds([file.id]);
    for (const model of models) {
      await assertLease();
      await FabFileChunkSearchIndex.deleteByFabFileIdOrThrow(file.id, model);
    }
  }
  await assertLease();
  await fabFileRepository.hardDeleteWithChunks(file.id, BATCH_SIZE, assertLease);
}

async function purgeKnowledgeFiles(userId: string, options: PurgeOptions, cdn: CdnInvalidationBatch): Promise<void> {
  const personalWorkspaces = await Organization.find({ userId, personal: true })
    .setOptions({ includeDeleted: true })
    .select('_id');
  const personalWorkspaceIds = personalWorkspaces.map(workspace => String(workspace._id));
  let afterId: string | undefined;
  while (true) {
    await options.assertLease();
    const batch = await FabFile.find({
      $or: [{ userId }, { organizationId: { $in: personalWorkspaceIds } }],
      ...(afterId ? { _id: { $gt: afterId } } : {}),
    })
      .setOptions({ includeDeleted: true })
      .sort({ _id: 1 })
      .limit(BATCH_SIZE);
    if (batch.length === 0) return;
    for (const file of batch) {
      if (file.moderationStatus === 'blocked' || (await isOrganizationFile(file, userId))) {
        options.logger.info('Account purge retained organization or moderation-held file', { fileId: file.id });
        continue;
      }
      if (file.moderationStatus === 'pending') {
        throw new Error(`Account purge is waiting for moderation of file ${file.id}`);
      }
      await purgeFile(file, options, cdn);
    }
    afterId = batch[batch.length - 1].id;
  }
}

const storedFileSchema = z.object({ path: z.string().min(1) });
const importFileSchema = z.object({ s3Bucket: z.string().min(1), s3Key: z.string().min(1) });

async function purgeAppFiles(
  userId: string,
  assertLease: () => Promise<void>,
  cdn: CdnInvalidationBatch
): Promise<void> {
  while (true) {
    await assertLease();
    const batch = await AppFile.collection.find({ userId }).limit(BATCH_SIZE).toArray();
    if (batch.length === 0) return;
    for (const row of batch) {
      const { path } = storedFileSchema.parse(row);
      await assertLease();
      await getAppFilesStorage().deletePermanently(path);
      cdn.add(appFileCdnPath(path));
      await assertLease();
      await AppFile.collection.deleteOne({ _id: row._id, userId });
    }
  }
}

async function purgeImportArchives(userId: string, assertLease: () => Promise<void>): Promise<void> {
  // Raw collection includes completed and soft-deleted imports; the repository's normal
  // find hook hides tombstones while their original uploaded ZIP can still contain all chats.
  const database = mongoose.connection.db;
  if (!database) throw new Error('Account purge requires a connected database');
  const model = mongoose.model('ImportHistoryJob');
  const collection = database.collection(model.collection.name);
  while (true) {
    await assertLease();
    const batch = await collection.find({ userId }).limit(BATCH_SIZE).toArray();
    if (batch.length === 0) return;
    for (const row of batch) {
      const { s3Bucket, s3Key } = importFileSchema.parse(row);
      if (s3Bucket !== Resource.historyImportBucket.name) throw new Error('Import archive has an unexpected bucket');
      await assertLease();
      await new S3Storage(s3Bucket).deletePermanently(s3Key);
      await assertLease();
      await collection.deleteOne({ _id: row._id, userId });
    }
  }
}

/** Strict, resumable storage erasure. Row locators survive every failed object/index deletion. */
export async function purgeAccountFiles(userId: string, options: PurgeOptions): Promise<void> {
  // Importing the repository registers its Mongoose model before the raw tombstone-inclusive read.
  void importHistoryJobRepository;
  // One CDN invalidation for everything erased, flushed even when a step throws: the bytes are gone either way.
  const cdn = createCdnInvalidationBatch('account-files', options.logger);
  try {
    await purgeKnowledgeFiles(userId, options, cdn);
    await purgeAppFiles(userId, options.assertLease, cdn);
  } finally {
    await cdn.flush();
  }
  await purgeImportArchives(userId, options.assertLease);
  // Notebook download copies: the current exports/ location plus the legacy one no lifecycle rule reaps.
  // Safe only while durable curated files stay at curated-notebooks/<uuid> (fabFileService create.ts)
  // and curated-notebooks/jobs/<sha> (workers queueHandlers/notebookCuration.ts), never under a user id.
  for (const prefix of ['exports/account-data', NOTEBOOK_DOWNLOAD_KEY_PREFIX, 'curated-notebooks']) {
    await options.assertLease();
    await getFilesStorage().deletePrefixPermanently(`${prefix}/${encodeURIComponent(userId)}/`);
  }
}
