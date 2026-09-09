import {
  IAdminSettingsRepository,
  IDataLakeAccessGrantRepository,
  IDataLakeRepository,
  IFabFileDocument,
  IScopedSettingsRepository,
  IUserDocument,
  KnowledgeType,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { BadRequestError, computeContentHash, secureParameters } from '@bike4mind/utils';
import { fetchAndParseURL } from '@bike4mind/utils';
import { z } from 'zod';
import { createFabFile, CreateFabFileAdapters } from './create';

/**
 * Thrown by `createFabFileByUrl` when the adapter-supplied `checkDuplicate` finds a live match
 * for the fetched content's hash, BEFORE any row is created - so a caller that dedupes never
 * strands a row the way a create-then-check ordering would. A thrown error rather than a
 * changed return type: every other caller (the web URL door, the proposal-admission door)
 * never supplies `checkDuplicate` and so can never see this thrown, keeping their contract
 * exactly as it was before this existed.
 */
export class DuplicateFabFileError extends Error {
  constructor(
    /** The already-live FabFile this fetch's content hash matches. */
    public readonly existing: IFabFileDocument,
    /** The title `fetchAndParseURL` resolved for THIS attempt - what the caller should name the skip. */
    public readonly fetchedTitle: string
  ) {
    // Generic on purpose: this class is thrown for ANY `checkDuplicate` caller, not only the Slack
    // data-lake path - a "data lake" specific message here would misdescribe a future caller that
    // dedupes against something else. Callers that need lake-specific wording build it themselves
    // (see `dataLakeLinkIngest.ts`'s catch, which never reads this message).
    super('Duplicate content already exists');
    this.name = 'DuplicateFabFileError';
  }
}

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
    // Optional, but wire it: this `db` is handed straight to `createFabFile`, whose admission
    // contract (#1680) resolves its enforcement lever from here. Absent, the lever resolves
    // platform-only and a per-org/owner/lake override silently does nothing on this door.
    scopedSettings?: Pick<IScopedSettingsRepository, 'findOverrides'>;
    users: {
      findById: (id: string) => Promise<IUserDocument | null>;
    };
    dataLakes: Pick<IDataLakeRepository, 'findByDatalakeTag'>;
    // Forwarded to createFabFile's lake-tag write gate. Wire it whenever the caller stamps a lake
    // tag on behalf of a principal who may manage that lake by grant rather than by having created
    // it, or the gate silently loses the curator and transferred-owner rungs.
    dataLakeAccessGrants?: Pick<IDataLakeAccessGrantRepository, 'listByLake'>;
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
  /** Forwarded verbatim to `createFabFile` - see its adapter doc for when this must be supplied. */
  administeredOrgIds?: string[];
  /**
   * Per-lake content-hash dedup, run AFTER the fetch (so the hash reflects what was actually
   * retrieved) and BEFORE `createFabFile` (so a match never creates a row). Optional: the web URL
   * door and the proposal-admission door supply nothing here and are unaffected - only the Slack
   * link path opts in. Return the existing match to skip, or null to proceed.
   */
  checkDuplicate?: (contentHash: string) => Promise<IFabFileDocument | null>;
};

export const createFabFileByUrl = async (
  userId: string,
  parameters: CreateFabFileByUrlParameters,
  { db, storage, tags, provenance, deleteCreatedFile, administeredOrgIds, checkDuplicate }: CreateFabFileByUrlAdapters
) => {
  const logger = new Logger();
  const params = secureParameters(parameters, createFabFileByUrlSchema);
  const user = await db.users.findById(userId);
  if (!user) throw new BadRequestError('User not found');

  const { textContent, mimeType, title } = await fetchAndParseURL(params.url, { logger });

  const fileSize = typeof textContent === 'string' ? Buffer.byteLength(textContent) : textContent.length;
  // Hashes whatever `fetchAndParseURL` returned - extracted text for most content, raw bytes for a
  // PDF (see `ingest.ts`'s `urlContent = body` arm). Either way, identical input deterministically
  // produces identical `textContent`, so this still satisfies "byte-identical fetched bodies are
  // duplicates" without widening `fetchAndParseURL`'s own contract.
  //
  // Only computed/checked/stamped when there is content: an empty fetch (a JS-only or paywalled
  // page) would otherwise share one `computeContentHash('')` key across every such page, making
  // unrelated empty fetches collide with each other as false "duplicates".
  const contentHash = fileSize > 0 ? computeContentHash(textContent) : undefined;

  if (contentHash && checkDuplicate) {
    const existing = await checkDuplicate(contentHash);
    if (existing) throw new DuplicateFabFileError(existing, title);
  }

  const fabFile = await createFabFile(
    userId,
    {
      fileName: title,
      mimeType,
      fileSize,
      type: KnowledgeType.URL,
      public: false,
      prefix: 'url',
      contentHash,
      // Forwarded from the adapters, not from `params` - see the `tags` note above.
      ...(tags && { tags }),
    },
    {
      db,
      storage,
      provenance,
      administeredOrgIds,
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
