import { IAdminSettingsRepository, IFabFileDocument, IUserDocument, KnowledgeType } from '@bike4mind/common';
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
};

export const createFabFileByUrl = async (
  userId: string,
  parameters: CreateFabFileByUrlParameters,
  { db, storage, tags, provenance }: CreateFabFileByUrlAdapters
) => {
  const params = secureParameters(parameters, createFabFileByUrlSchema);
  const user = await db.users.findById(userId);
  if (!user) throw new BadRequestError('User not found');

  const { textContent, mimeType, title } = await fetchAndParseURL(params.url, { logger: new Logger() });

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
    await storage.upload(fabFile.filePath, textContent, { ContentType: mimeType });
  }

  return fabFile;
};
