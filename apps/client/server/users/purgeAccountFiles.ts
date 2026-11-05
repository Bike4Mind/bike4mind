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
import {
  getAppFilesStorage,
  getFilesStorage,
  getGeneratedImageStorage,
} from '@bike4mind/server-utils/utils/storage/index';
import { getGeneratedCopyStore } from '@server/files/generatedCopyStore';
import { Resource } from 'sst';
import { z } from 'zod';

type PurgeOptions = { logger: Pick<Logger, 'info' | 'warn' | 'error'>; assertLease: () => Promise<void> };
const BATCH_SIZE = 50;

/** Preserve legacy org uploads which predate the organizationId ownership stamp. */
async function isOrganizationFile(file: IFabFileDocument, userId: string): Promise<boolean> {
  const lakes = file.organizationId
    ? []
    : await dataLakeService.findMemberLakesForFile(file, {
        find: async filter =>
          (await DataLakeModel.find(filter).setOptions({ includeDeleted: true })).map(lake => lake.toObject()),
        findByDatalakeTag: async datalakeTag => {
          const lake = await DataLakeModel.findOne({ datalakeTag }).setOptions({ includeDeleted: true });
          return lake?.toObject() ?? null;
        },
      });
  const organizationId = file.organizationId || fabFilesService.pickOwnerOrganizationId(lakes, file.sourceLakeId);
  if (!organizationId) return false;
  // A personal workspace is owned by this account and is removed by the purge's final
  // transaction. Its files must go too; genuine organizations retain their own content.
  const personalWorkspace = await Organization.exists({ _id: organizationId, userId, personal: true }).setOptions({
    includeDeleted: true,
  });
  return !personalWorkspace;
}

async function purgeFile(file: IFabFileDocument, { logger, assertLease }: PurgeOptions): Promise<void> {
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
            if (!other) await getGeneratedImageStorage().deletePermanently(key);
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

async function purgeKnowledgeFiles(userId: string, options: PurgeOptions): Promise<void> {
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
      await purgeFile(file, options);
    }
    afterId = batch[batch.length - 1].id;
  }
}

const storedFileSchema = z.object({ path: z.string().min(1) });
const importFileSchema = z.object({ s3Bucket: z.string().min(1), s3Key: z.string().min(1) });

async function purgeAppFiles(userId: string, assertLease: () => Promise<void>): Promise<void> {
  while (true) {
    await assertLease();
    const batch = await AppFile.collection.find({ userId }).limit(BATCH_SIZE).toArray();
    if (batch.length === 0) return;
    for (const row of batch) {
      const { path } = storedFileSchema.parse(row);
      await assertLease();
      await getAppFilesStorage().deletePermanently(path);
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
  await purgeKnowledgeFiles(userId, options);
  await purgeAppFiles(userId, options.assertLease);
  await purgeImportArchives(userId, options.assertLease);
  await options.assertLease();
  await getFilesStorage().deletePrefixPermanently(`exports/account-data/${encodeURIComponent(userId)}/`);
}
