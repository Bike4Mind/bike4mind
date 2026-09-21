import {
  DuplicateFabFileError,
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

const createFabFileByUrlSchema = z.object({
  url: z
    .string()
    // Google Drive Links are not supported for now
    .regex(
      /^(?!https?:\/\/(drive|docs)\.google\.com\/(?:file\/d\/|open\?id=|uc\?id=|document\/d\/|spreadsheets\/d\/|presentation\/d\/|forms\/d\/|drive\/folders\/)([a-zA-Z0-9_-]{10,})).+/
    ),
});

type CreateFabFileByUrlParameters = z.infer<typeof createFabFileByUrlSchema>;

/**
 * See the `contentHash` computation below for why this exists. Set well clear of the boilerplate
 * remnants a chrome-pruning rollback can leave behind (measured up to ~29 characters against real
 * link-directory pages) - a false collision between two unrelated pages is worse than a genuine
 * short page missing dedup.
 */
const MIN_CONTENT_LENGTH_FOR_DEDUP = 100;

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
    // 'find' is forwarded straight to createFabFile, for its fallback tagger's prefix-overlap check.
    dataLakes: Pick<IDataLakeRepository, 'findByDatalakeTag' | 'find'>;
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
  // A zero-length body is refused on BOTH arms: an empty extracted string (no readable text on the
  // page) and an empty PDF Buffer alike (a zero-byte PDF is no more legitimate content than a
  // zero-character page) - either would otherwise create a phantom 0-byte FabFile.
  if (fileSize === 0) {
    throw new BadRequestError('No readable text could be extracted from that URL');
  }

  // Hashes whatever `fetchAndParseURL` returned - extracted text for most content, raw bytes for a
  // PDF (see `ingest.ts`'s `urlContent = body` arm). Either way, identical input deterministically
  // produces identical `textContent`, so this still satisfies "byte-identical fetched bodies are
  // duplicates" without widening `fetchAndParseURL`'s own contract.
  //
  // For HTML extraction specifically, skipped below `MIN_CONTENT_LENGTH_FOR_DEDUP`: `ingest.ts`'s
  // chrome-pruning rollback trusts a prune once as little as ~20 characters of the page's own text
  // survive it, so a link-directory-style page can legitimately extract down to nothing but a short
  // boilerplate remnant (a copyright line, a "Further reading." label). Two UNRELATED pages that both
  // reduce to the same short remnant would otherwise hash identically and the second would be rejected
  // outright as a duplicate of the first - turning silent content thinning into a hard, user-visible
  // failure. A short extraction not being deduped is a safe miss (the file is still created); hashing
  // it anyway is not, so this is deliberately conservative. PDFs (`textContent` is a `Buffer`) are
  // unaffected - the chrome-pruning floor above only applies to the HTML extraction path.
  const isThinHtmlExtraction = typeof textContent === 'string' && textContent.length < MIN_CONTENT_LENGTH_FOR_DEDUP;
  const contentHash = isThinHtmlExtraction ? undefined : computeContentHash(textContent);

  if (contentHash && checkDuplicate) {
    const existing = await checkDuplicate(contentHash);
    if (existing) throw new DuplicateFabFileError(existing, title);
  }

  // Stamped on the row ONLY when a caller opted into ingest-time dedup (`checkDuplicate` supplied),
  // deliberately keeping the stamp coupled to the dedup behavior rather than stamping it on every
  // door. `unarchiveDataLake.ts`'s hard-delete dedup pass (the family's only HARD delete) reads this
  // same field across every FabFile, regardless of which door created it - stamping it unconditionally
  // would enroll doors that never asked for content-hash dedup (the web-upload and proposal-admission
  // doors) in that pass too. Since this door hashes extracted TEXT rather than the URL, two
  // provenance-distinct rows (a canonical page vs. its tracking-parameter/print/AMP variant) can share
  // a hash - fine as an ingest-time dedup signal for the door that asked for it, but not safe to feed
  // into an irreversible delete on doors that never opted in.
  const stampedContentHash = checkDuplicate ? contentHash : undefined;

  const fabFile = await createFabFile(
    userId,
    {
      fileName: title,
      mimeType,
      fileSize,
      type: KnowledgeType.URL,
      public: false,
      prefix: 'url',
      contentHash: stampedContentHash,
      // Forwarded from the adapters, not from `params` - see the `tags` note above.
      ...(tags && { tags }),
    },
    {
      db,
      storage,
      provenance,
      administeredOrgIds,
      // mimeType comes from fetchAndParseURL's HTTP response, not the client; title is free-form
      // page text (a <title> or URL segment) and must not be able to outrank it.
      //
      // createFabFile still passes its own extensionlessFallback (text/plain) through unconditionally,
      // but it is unreachable from this door: fetchAndParseURL only ever returns 'application/pdf' or
      // 'text/plain' (both supported), so under claim-first the claim always resolves first. A future
      // change widening fetchAndParseURL's mimeType set must keep that invariant in mind.
      mimeTypePrecedence: 'claim-first',
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
