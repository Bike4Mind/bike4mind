import {
  IAdminSettingsRepository,
  IDataLakeRepository,
  IFabFileDocument,
  IUserDocument,
  KnowledgeType,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { BadRequestError, secureParameters } from '@bike4mind/utils';
import { fetchAndParseURL } from '@bike4mind/utils';
import { z } from 'zod';
import { createFabFile, CreateFabFileAdapters } from './create';

const createFabFileByUrlSchema = z.object({
  url: z
    .string()
    // Google Drive Links are not supported for now
    .regex(
      /^(?!https?:\/\/(drive|docs)\.google\.com\/(?:file\/d\/|open\?id=|uc\?id=|document\/d\/|spreadsheets\/d\/|presentation\/d\/|forms\/d\/|drive\/folders\/)([a-zA-Z0-9_-]{10,})).+/
    ),
});

type CreateFabFileByUrlParameters = z.infer<typeof createFabFileByUrlSchema>;

type CreateFabFileByUrlAdapters = {
  db: {
    fabFiles: {
      create: (data: Omit<IFabFileDocument, 'id'>) => Promise<IFabFileDocument>;
    };
    adminSettings: IAdminSettingsRepository;
    users: {
      findById: (id: string) => Promise<IUserDocument | null>;
    };
    dataLakes: Pick<IDataLakeRepository, 'findByDatalakeTag'>;
  };
  storage: {
    upload: CreateFabFileAdapters['storage']['upload'];
    generateSignedUrl: CreateFabFileAdapters['storage']['generateSignedUrl'];
  };
  /**
   * Tags to stamp on the created file.
   *
   * An ADAPTER, deliberately not a field on `createFabFileByUrlSchema`, even though `createFabFile`
   * takes `tags` as an ordinary parameter. A data-lake meta-tag is permission-bearing - stamping one
   * is what puts a file in a lake - and this schema is `secureParameters`-parsed straight from an
   * HTTP request body. A body-supplied tag would therefore turn the web URL door
   * (`pages/api/files/createFabFileURL.ts`), which runs no lake-tag write gate, into an unguarded
   * path into any lake. Only a server-side caller that has already run the gate can pass these.
   * Same reasoning as `provenance` below.
   */
  tags?: Array<{ name: string; strength: number }>;
  /** Where this file came from, stamped by the server that fetched it. See `CreateFabFileAdapters`. */
  provenance?: CreateFabFileAdapters['provenance'];
  /**
   * Compensating delete, invoked ONLY when the upload that follows the create fails. See the upload
   * below for what it prevents.
   *
   * Optional because the web URL door (`pages/api/files/createFabFileURL.ts`) wraps this call in
   * `withTransaction`, so its create already rolls back on a throw. The Slack link path is
   * deliberately un-transactioned (a transaction there would span an outbound fetch) and so has no
   * rollback of its own - it supplies this instead.
   */
  deleteCreatedFile?: (id: string) => Promise<unknown>;
};

export const createFabFileByUrl = async (
  userId: string,
  parameters: CreateFabFileByUrlParameters,
  { db, storage, tags, provenance, deleteCreatedFile }: CreateFabFileByUrlAdapters
) => {
  const logger = new Logger();
  const params = secureParameters(parameters, createFabFileByUrlSchema);
  const user = await db.users.findById(userId);
  if (!user) throw new BadRequestError('User not found');

  const { textContent, mimeType, title } = await fetchAndParseURL(params.url, { logger });

  const fileSize = typeof textContent === 'string' ? Buffer.byteLength(textContent) : textContent.length;

  const fabFile = await createFabFile(
    userId,
    {
      fileName: title,
      mimeType,
      fileSize,
      type: KnowledgeType.URL,
      public: false,
      prefix: 'url',
      // Forwarded from the adapters, not from `params` - see the `tags` note above.
      ...(tags && { tags }),
    },
    {
      db,
      storage,
      provenance,
    }
  );

  if (fabFile.filePath) {
    try {
      await storage.upload(fabFile.filePath, textContent, { ContentType: mimeType });
    } catch (uploadError) {
      // The row now exists with a `filePath` whose object does not, and nothing will ever reconcile
      // that: chunk/vectorize is driven by the S3 ObjectCreated event, so the file would sit in lake
      // and file queries permanently unindexable. Undo the create, then rethrow so the caller still
      // reports a failure rather than a success with a missing file.
      try {
        await deleteCreatedFile?.(fabFile.id);
      } catch (cleanupError) {
        // Best effort only. The upload error is the one worth surfacing, so this is logged and
        // swallowed rather than allowed to mask it.
        logger.debug('Failed to clean up FabFile after a failed URL upload:', cleanupError);
      }
      throw uploadError;
    }
  }

  return fabFile;
};
