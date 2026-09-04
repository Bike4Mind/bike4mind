/* eslint @typescript-eslint/no-explicit-any: "error" */
import { InboxType, isImageServeable } from '@bike4mind/common';
import type { ArtifactType } from '@bike4mind/common';
import { artifactService, notebookImportService } from '@bike4mind/services';
import { Logger } from '@bike4mind/observability';
import { S3Storage } from '@bike4mind/fab-pipeline';
import {
  inboxRepository,
  sessionRepository,
  Quest,
  FabFile,
  Artifact,
  ArtifactContent,
  ArtifactVersion,
  Agent,
  Tool,
  User,
  withTransaction,
  importHistoryJobRepository,
} from '@bike4mind/database';
import { withContext } from '@server/s3/utils';
import type { ClientSession, FilterQuery } from 'mongoose';
import type {
  IArtifactContentDocument,
  IArtifactDocument,
  IArtifactVersionDocument,
  IChatHistoryItem,
  IChatHistoryItemDocument,
} from '@bike4mind/common';
import { Resource } from 'sst';
import { getFilesStorage } from '@server/utils/storage';
import { v4 as uuidv4 } from 'uuid';
import { updateImportProgress, markImportComplete, markImportFailed } from '@server/utils/importHistoryProgress';

const { NotebookImportService } = notebookImportService;

/**
 * The notebook-metadata writes an import performs. Exported for the same reason as the message
 * writes below: a test that re-implements these cannot catch them regressing.
 *
 * No `ctx` is assigned on the repository: transactionAsyncLocalStorage already carries the session
 * into these queries, and assigning it would strand a finished session on the shared instance -
 * the next caller to read it fails with "Use of expired sessions".
 */
export const createSessionWrites = () => ({
  // The service hands over a plain literal; the repository wants a session document. Casting here
  // keeps that boundary in one visible place instead of widening either side.
  create: async (data: Record<string, unknown>) =>
    sessionRepository.create(data as Parameters<typeof sessionRepository.create>[0]),
  find: async (query: Record<string, unknown>) => sessionRepository.find(query),
  // `update` identifies the row by `id` and throws without it - `_id` here silently made every
  // overwrite and merge import fail.
  updateById: async (id: string, data: Record<string, unknown>) => sessionRepository.update({ id, ...data }),
});

/**
 * The message writes an import performs. Exported so the invariant below is testable against a
 * real database rather than a copy of it - see notebookImportOverwrite.e2e.test.ts.
 */
export const createChatHistoryWrites = (session?: ClientSession) => {
  // The key must be absent, not present-and-undefined: the session guards are presence checks, so
  // `{ session: undefined }` makes the write escape the caller's transaction. See BaseModel.delete.
  const txn = session ? { session } : {};
  return {
    bulkCreate: async (items: IChatHistoryItem[]) => {
      // Insert, never upsert: an upsert on the incoming id re-pointed the *source* documents at
      // the new notebook when an export was imported back into its own database, emptying the
      // original.
      //
      // skipValidation keeps this as lenient as the update it replaces. Inserts validate where
      // updates do not, and ChatHistoryItemSchema marks `prompt` required (QuestModel.ts) while
      // the system writes empty ones - an assistant-first turn has no prompt - so validating here
      // would fail imports that currently work. Note it waives every validator on the schema, not
      // just that one; bulkWrite has no per-field opt-out.
      const ops = items.map(({ id, ...rest }) => ({
        insertOne: { document: id ? { _id: id, ...rest } : rest },
      }));
      return Quest.bulkWrite(ops, { ...txn, skipValidation: true });
    },
    deleteMany: async (filter: FilterQuery<IChatHistoryItemDocument>) => {
      // Hard delete: the soft-delete default leaves the rows with their ids, so the replacement
      // insert in bulkCreate collides with the documents it supersedes.
      return Quest.deleteMany(filter, { ...txn, hardDelete: true });
    },
  };
};

/**
 * Binds one model's `create` to a transaction, for a service that only knows how to call `create`.
 *
 * `T` is named by the caller rather than inferred from a `Model<T>`: @bike4mind/database types these
 * models on documents whose `_id`/`contentId` are ObjectIds, while the ports the services want
 * declare them strings, so the cast is load-bearing and no signature can tie the two together.
 */
const withSession = <T>(
  session: ClientSession | undefined,
  model: { create: (docs: unknown[], options: Record<string, unknown>) => Promise<unknown[]> }
) => ({
  // Same presence-check hazard as createChatHistoryWrites: `{ session: undefined }` escapes the
  // transaction rather than being ignored, so the key has to be absent.
  create: async (data: unknown) => {
    const [created] = await model.create([data], session ? { session } : {});
    return created as T;
  },
});

/**
 * The artifact writes an import performs. Exported for the same reason as the message writes above:
 * an artifact is three linked documents, and a test that re-implements that link cannot catch it
 * regressing - see notebookImportArtifact.e2e.test.ts.
 */
export const createArtifactWrites = (session?: ClientSession) => ({
  // Session-bound, so it sees artifacts written earlier in this same import and not only
  // committed ones.
  artifactExists: async (id: string) => {
    const query = Artifact.exists({ id });
    return (await (session ? query.session(session) : query)) !== null;
  },
  // Delegates to the same creation path the artifacts API uses rather than hand-building a
  // payload that drifts from the schema; see NotebookImportAdapters.createArtifact for why.
  // The service's adapter seam is what lets its three writes join this transaction.
  createArtifact: async ({
    userId,
    ...params
  }: {
    userId: string;
    id?: string;
    sessionId: string;
    type: ArtifactType;
    title: string;
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<string> => {
    const written = await artifactService.create(
      userId,
      {
        ...params,
        metadata: params.metadata ?? {},
        // Private regardless of what the source artifact was: an import must not publish
        // anything on the importer's behalf. Tags are not carried by the export format.
        visibility: 'private',
        tags: [],
      },
      {
        db: {
          artifacts: withSession<IArtifactDocument>(session, Artifact),
          artifactContents: withSession<IArtifactContentDocument>(session, ArtifactContent),
          artifactVersions: withSession<IArtifactVersionDocument>(session, ArtifactVersion),
        },
      }
    );
    // Read back off the stored row, not off the payload: when no id was supplied the creation path
    // minted one, and that is the id readers resolve the artifact by.
    return String((written.artifact as unknown as { id: string }).id);
  },
});

const processNotebookImport = async (
  userId: string,
  dataKey: string,
  optionsKey: string,
  bucket: string,
  logger: Logger,
  importHistoryJobId: string
) => {
  return withTransaction(async session => {
    const s3 = new S3Storage(bucket);

    try {
      const [importDataBuffer, optionsBuffer] = await Promise.all([
        s3.getContentAsBuffer(dataKey),
        s3.getContentAsBuffer(optionsKey),
      ]);

      const importData = JSON.parse(importDataBuffer.toString('utf-8'));
      const options = JSON.parse(optionsBuffer.toString('utf-8'));

      logger.info('Processing notebook import', {
        userId,
        dataKey,
        notebookCount: importData.notebooks?.length || 0,
        options,
      });

      // Create service adapters (matching the export service pattern)
      const adapters = {
        sessionRepository: createSessionWrites(),
        chatHistoryRepository: createChatHistoryWrites(session),
        // These three only ever have an id read back off them, which is all the port asks for.
        knowledgeRepository: withSession<{ id: unknown }>(session, FabFile),
        ...createArtifactWrites(session),
        toolRepository: withSession<{ id: unknown }>(session, Tool),
        agentRepository: withSession<{ id: unknown }>(session, Agent),
        userRepository: {
          findById: async (id: string) => User.findById(id).session(session),
        },
        fileStorageService: {
          getFileContent: async (path: string) => {
            try {
              // This adapter has no live caller today (copyFileFromUrl(), the only call
              // site that would need it, is an unimplemented stub that just returns the
              // source URL unchanged), but it reads raw bytes from a storage path with no
              // moderation check. Gate defensively so a future implementation of
              // copyFileFromUrl() can't leak a held/blocked uploaded image's bytes. No
              // FabFile match (e.g. a non-fabfile asset) falls through unaffected.
              const fabFile = await FabFile.findOne({ filePath: path }).session(session);
              if (fabFile && !isImageServeable(fabFile)) {
                logger.warn('Refusing to read content for unmoderated image', { path });
                return null;
              }
              const buffer = await getFilesStorage().getContentAsBuffer(path);
              return buffer.toString('base64');
            } catch (error) {
              logger.warn('Failed to get file content', { path, error });
              return null;
            }
          },
          uploadFile: async (path: string, content: Buffer) => {
            await getFilesStorage().upload(content, path);
          },
          getSignedUrl: async (path: string, expiresIn = 3600) => {
            try {
              // Same dead-today, defensive gate as getFileContent above: mirrors
              // fabFileService/get.ts by withholding the signed URL for a held/blocked
              // uploaded image.
              const fabFile = await FabFile.findOne({ filePath: path }).session(session);
              if (fabFile && !isImageServeable(fabFile)) {
                logger.warn('Refusing to mint signed URL for unmoderated image', { path });
                return null;
              }
              return await getFilesStorage().getSignedUrl(path, 'get', { expiresIn });
            } catch (error) {
              logger.warn('Failed to get signed URL', { path, error });
              return null;
            }
          },
        },
        logger,
        generateId: () => uuidv4(),
        onProgress: async (progress: number, currentStep: string, processed: number, total: number) => {
          await updateImportProgress(importHistoryJobId, userId, {
            progress,
            currentStep,
            processedItems: processed,
            totalItems: total,
          });
        },
      };

      const importService = new NotebookImportService(adapters);
      const result = await importService.importNotebooks(userId, importData, options);

      // Any per-notebook failure rolls the whole import back. A failed write usually aborts the
      // transaction server-side already, but a client-side cast error leaves it healthy.
      if (result.errors?.length) {
        throw new Error(`Imported no notebooks: ${result.errors.join('; ')}`);
      }

      await markImportComplete(importHistoryJobId, userId, {
        processedItems: result.importedNotebooks + result.importedMessages,
        skippedItems: result.skippedNotebooks,
      });

      // Attachment failures are warnings, not errors, so they do not abort the import - but the
      // user still has to hear about them, or a notebook silently arrives without its files.
      const warnings = result.warnings ?? [];
      const shown = warnings.slice(0, 5);
      // Assembled from parts and joined, so an absent clause cannot leave a double space behind.
      const parts = [
        `Successfully imported ${result.importedNotebooks} notebook(s) with ${result.importedMessages} messages.`,
      ];
      if (result.skippedNotebooks > 0) {
        parts.push(`Skipped ${result.skippedNotebooks} duplicate(s).`);
      }
      if (warnings.length) {
        // Neutral wording on purpose: not every entry is a failure. A file that imported with its
        // type degraded says so itself, and calling that "could not be imported" contradicts the
        // record. Each message states its own outcome.
        const more = warnings.length > shown.length ? `; and ${warnings.length - shown.length} more` : '';
        parts.push(`${warnings.length} attachment issue(s): ${shown.join('; ')}${more}.`);
      }

      await inboxRepository.createInboxMessage({
        type: InboxType.COMMON,
        title: warnings.length ? '⚠️ Notebook Import Completed With Issues' : '✅ Notebook Import Successful',
        message: parts.join(' '),
        receiverId: userId,
        userId,
      });

      logger.info('Notebook import completed successfully', { userId, result });
      return result;
    } catch (error) {
      // Reporting the failure happens in the caller, not here. A failed write aborts the
      // transaction server-side, and every write in this scope picks that session up from
      // async-local storage, so a status update or inbox message written here would itself fail
      // and the user would hear nothing.
      logger.error('Notebook import failed', { userId, dataKey, error });
      throw error;
    } finally {
      await Promise.all([
        s3.delete(dataKey).catch(err => logger.warn('Failed to delete data file', { dataKey, error: err })),
        s3.delete(optionsKey).catch(err => logger.warn('Failed to delete options file', { optionsKey, error: err })),
      ]);
    }
  });
};

export const dispatch = withContext(async (event, context, logger) => {
  if (!event.Records || event.Records.length === 0) {
    logger.error('No records found in S3 event');
    return;
  }

  for (const record of event.Records) {
    if (!record.s3) {
      logger.error('No S3 record found');
      continue;
    }

    if (record.s3.bucket.name !== Resource.historyImportBucket.name) {
      logger.error(`Invalid bucket: ${record.s3.bucket.name}`);
      continue;
    }

    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

    // Only process notebook imports (skip options files)
    if (!key.startsWith('notebooks/') || key.endsWith('.options.json')) {
      logger.debug('Skipping non-notebook or options file', { key });
      continue;
    }

    const [, userId, filename] = key.split('/'); // prefix not used
    const timestamp = filename?.split('.')[0];

    if (!userId || !timestamp) {
      logger.error('Invalid key format', { key });
      continue;
    }

    const optionsKey = `notebooks/${userId}/${timestamp}.options.json`;

    try {
      logger.info('Processing notebook import', { key, optionsKey });

      const s3 = new S3Storage(bucket);
      let fileSize: number;
      try {
        const metadata = await s3.getMetadata(key);
        fileSize = metadata.size ?? 0;
      } catch (err: unknown) {
        // Read the name off the value rather than gating on `instanceof Error`: a plain-object or
        // cross-realm rejection would otherwise turn a duplicate S3 event into a failed import.
        // Same form as pages/api/app-files/serve/[...key].ts.
        const name = (err as { name?: string })?.name;
        if (name === 'NoSuchKey' || name === 'NotFound') {
          logger.info(`File ${key} already processed (doesn't exist), skipping duplicate event`);
          continue;
        }
        throw err;
      }

      // Check for existing job by S3 key (idempotency)
      let importJob;
      const existingJob = await importHistoryJobRepository.findByS3Key(key);
      if (existingJob) {
        // Allow reprocessing if the job is pending (indicates a retry)
        if (existingJob.status === 'pending') {
          logger.info(`Job ${existingJob.id} is pending retry, continuing processing`);
          importJob = existingJob;
        } else {
          logger.info(`Job already exists for ${key} with status ${existingJob.status}, skipping duplicate event`);
          continue;
        }
      } else {
        // Check for active imports (concurrency control) - only for new imports
        const hasActiveImport = await importHistoryJobRepository.hasActiveImport(userId);
        if (hasActiveImport) {
          logger.info(`User ${userId} already has an active import, skipping`);
          await inboxRepository.createInboxMessage({
            type: InboxType.COMMON,
            title: 'Import Already in Progress',
            message: `You already have an import in progress. Please wait for it to complete before starting a new one.`,
            receiverId: userId,
            userId,
          });
          continue;
        }

        importJob = await importHistoryJobRepository.create({
          userId,
          source: 'Notebook',
          s3Bucket: bucket,
          s3Key: key,
          fileSize,
          status: 'pending',
          progress: 0,
          currentStep: 'Starting notebook import...',
          totalItems: 0,
          processedItems: 0,
          skippedItems: 0,
          failedItems: 0,
        });

        logger.info(`Created import job ${importJob.id} for user ${userId}`);
      }

      await importHistoryJobRepository.update({
        id: importJob.id,
        status: 'processing',
        startedAt: new Date(),
        currentStep: 'Loading notebook data...',
      });

      await processNotebookImport(userId, key, optionsKey, bucket, logger, importJob.id);
    } catch (error) {
      logger.error('Failed to process notebook import', {
        key,
        userId,
        error,
      });

      // Outside the import's transaction, so these still land when it is the transaction that
      // failed - which is the usual reason to be here.
      try {
        const existingJob = await importHistoryJobRepository.findByS3Key(key);
        if (existingJob && existingJob.status !== 'failed') {
          await markImportFailed(existingJob.id, userId, {
            message: error instanceof Error ? error.message : 'Unknown error',
            stack: error instanceof Error ? error.stack : undefined,
          });
        }
      } catch (markFailedErr) {
        logger.error('Failed to mark import as failed:', markFailedErr);
      }

      // Outside the try above, so a failed job lookup does not swallow the user's notification.
      await inboxRepository
        .createInboxMessage({
          type: InboxType.COMMON,
          title: '❌ Notebook Import Failed',
          message: `Failed to import notebooks. Error: ${
            error instanceof Error ? error.message : 'Unknown error'
          }. Please try again or contact support if the issue persists.`,
          receiverId: userId,
          userId,
        })
        .catch(notifyErr => logger.error('Failed to notify import failure:', notifyErr));
    }
  }
});
