import {
  IAdminSettingsRepository,
  IScopedSettingsRepository,
  IDataLakeAccessGrantRepository,
  IDataLakeRepository,
  IFabFileDocument,
  IUserDocument,
  IOrganizationDocument,
  FabFileSourceType,
  KnowledgeType,
  SupportedFabFileMimeTypes,
  isStorableFabFileMimeType,
  settingsMap,
} from '@bike4mind/common';
import {
  BadRequestError,
  checkStorageLimitForFile,
  getFileExtension,
  getSettingsMap,
  getSettingsValue,
  resolveSupportedMimeType,
  secureParameters,
} from '@bike4mind/utils';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { assertCanWriteDataLakeTags, assertCanWriteStaticRegistryTags } from '../dataLakeService/authorizeLakeWrite';
import { reconcileDataLakeFallbackTags } from '../dataLakeService/fallbackLakeTags';

export const createFabFileSchema = z.object({
  fileName: z.string(),
  mimeType: z.string(),
  fileSize: z.number(),
  type: z.enum(KnowledgeType),
  content: z.union([z.string(), z.instanceof(Buffer)]).optional(),
  organizationId: z.string().optional(),
  /**
   * Content type of the file
   * @example 'text/markdown'
   * @example 'application/pdf'
   * @example 'application/octet-stream' for binary files
   */
  contentType: z.string().optional(),
  public: z.boolean().optional(),
  prefix: z.string().optional(),
  system: z.boolean().optional(),
  tags: z.array(z.object({ name: z.string(), strength: z.number() })).optional(),
  systemPriority: z.number().optional(),
  sessionId: z.string().optional(),
  contentHash: z.string().optional(),
  batchId: z.string().optional(),
  relativePath: z.string().optional(),
});

type CreateFabFileParameters = z.infer<typeof createFabFileSchema>;

export interface CreateFabFileAdapters {
  db: {
    fabFiles: {
      create: (data: Omit<IFabFileDocument, 'id'>) => Promise<IFabFileDocument>;
    };
    adminSettings: Pick<IAdminSettingsRepository, 'findAll' | 'findBySettingNames'>;
    users: {
      findById: (id: string) => Promise<IUserDocument | null>;
    };
    organizations?: {
      findById: (id: string) => Promise<IOrganizationDocument | null>;
    };
    // 'find' is for the fallback tagger's prefix-overlap check (decideStampPrefix), not the write
    // gate above - the two happen to share this adapter.
    dataLakes: Pick<IDataLakeRepository, 'findByDatalakeTag' | 'find'>;
    // Optional, but WIRE IT on any door that stamps a lake tag on behalf of someone who may manage
    // that lake by grant or by org role. Absent, loadActiveLakeGrants returns [] and
    // assertCanWriteDataLakeTags degrades to the createdByUserId + org rungs only - which is
    // adequate for the upload fan-in (the actor is always the file's own owner, applying its own or
    // hardcoded tags) but NOT for the proposal-approval door, where the reviewer may be a curator or
    // a grant-transferred owner. See proposalAdmissionDeps.ts.
    dataLakeAccessGrants?: Pick<IDataLakeAccessGrantRepository, 'listByLake'>;
    // Optional: absent means the admission contract (#1680) resolves its enforcement lever from the
    // platform value only, so a caller that has no scoped store still gets the platform decision.
    scopedSettings?: Pick<IScopedSettingsRepository, 'findOverrides'>;
  };
  storage: {
    generateSignedUrl: (path: string, expireInSeconds: number, type?: 'get' | 'put') => Promise<string>;
    upload: (
      path: string,
      content: string | Buffer,
      options?: { ContentType?: string; ContentLength?: number }
    ) => Promise<string>;
  };
  /**
   * Where this file came from, stamped by the server that ingested it.
   *
   * Deliberately an ADAPTER rather than a field on `createFabFileSchema`: that schema is parsed
   * straight from an HTTP request body, so anything in it is caller-controlled. A client could
   * then upload its own file and label it `sourceType: SLACK` with someone else's channel and
   * message ts - forging exactly the audit trail provenance is meant to establish. Only a
   * server-side caller that actually performed the ingest can pass this.
   */
  provenance?: {
    sourceType: FabFileSourceType;
    sourceMetadata?: Record<string, unknown>;
  };
  /** Forwarded to the fallback tagger's skip-path diagnostics; never fails the write on its own. */
  logger?: { warn?: (msg: string, ...args: unknown[]) => void };
  /**
   * The acting principal's org-admin set, when the caller has already resolved it (toAccessContext
   * does). It cannot be read off the user document, so omitting it silently drops the two org rungs
   * of `canManageLake` - the actor is treated as administering nothing.
   *
   * Omit on the upload doors: their actor applies tags to a file it owns, so the org rungs are not
   * what authorizes them. PASS IT on any door writing a lake tag on someone else's authority, or
   * that door's write gate ends up strictly narrower than the route gate in front of it.
   */
  administeredOrgIds?: string[];
  /**
   * Which of the filename extension and the claimed `mimeType` wins; defaults to 'extension-first'.
   * An adapter rather than a `createFabFileSchema` field for the same reason as `provenance`: that
   * schema is parsed from a caller-controlled HTTP body, so only a server-side caller that vouches
   * for the claim (it read it off the stored object, not off the request) may let it outrank the name.
   */
  mimeTypePrecedence?: 'extension-first' | 'claim-first';
}

/**
 * MB. Only reached when the `MaxFileSize` settings row exists but fails the schema (a non-numeric
 * stored value, or a cleared field - stored as '', which coerces to 0 and fails the schema's
 * `min: 1`) - a missing row never gets here, since the schema's own prefault already resolves
 * `getSettingsValue` before this default arg is consulted. Read from the setting rather than
 * re-spelled so the two cases cannot diverge; the literal is only the never-taken arm of
 * makeNumberSetting's optional `defaultValue`, and an undefined here would make a door's byte
 * limit NaN, which admits every file. Shared with the notebook-import door, which gates on the
 * same setting.
 */
export const MAX_FILE_SIZE_DEFAULT_MB = settingsMap.MaxFileSize.defaultValue ?? 30;
const DEFAULT_EXPIRE_IN_SECONDS = 3600 * 24 * 5; // 5 days

/**
 * Every caller of `createFabFile` is gated against lake membership here, whether or not it also
 * gates itself up front (a few HTTP routes already call `assertCanWriteDataLakeTags` before
 * reaching this) - so a new caller, like `researchTaskService`/`downloadRelevantLinks` used to
 * be, cannot forget the check by omission. A write that bypasses this service entirely (e.g.
 * `fabFileRepository.create()`/a direct model call) gets NO such gate; today's few such bypasses
 * only ever set hardcoded or no tags, never a caller-controlled name, but a future one gaining a
 * caller-supplied `tags` field must route through here instead.
 *
 * The tags this persists also run through `reconcileDataLakeFallbackTags` (#2397), the same
 * fallback stamper `updateFabFile` runs on every whole-array tag write: a file created with only
 * a `datalake:*` meta-tag and no content tag under that lake's prefix gets its
 * `<prefix>uncategorized` stamp here, rather than being invisible to `tag-counts` and the
 * Explorer's tag tree until some later edit happens to trigger it. `previousTags` is deliberately
 * omitted - a create has no prior state to retract a stamp against.
 */
export const createFabFile = async (
  userId: string,
  parameters: CreateFabFileParameters,
  { db, storage, provenance, administeredOrgIds, logger, mimeTypePrecedence }: CreateFabFileAdapters
) => {
  const params = secureParameters(parameters, createFabFileSchema);
  const user = await db.users.findById(userId);
  if (!user) throw new BadRequestError('User not found');

  // `administeredOrgIds` cannot be derived from the user document, so a caller that already resolved
  // it (via toAccessContext) has to hand it over or the org rungs of canManageLake cannot fire. The
  // upload doors legitimately omit it - their actor owns the file and applies its own tags - but a
  // door admitting content for a reviewer must pass it, or an org admin of the lake's org is refused
  // a write the route's own manage gate just authorized.
  const actor = { userId, isAdmin: !!user.isAdmin, administeredOrgIds: administeredOrgIds ?? [] };
  const tagNames = (params.tags ?? []).map(t => t.name);
  // The file is created under `userId`, so it is its own owner-to-be for the admission contract.
  await assertCanWriteDataLakeTags(actor, tagNames, { db, members: [{ userId }] });
  assertCanWriteStaticRegistryTags(actor, tagNames);

  // A file joining a lake here must also land under that lake's content prefix, or it
  // contributes nothing to tag-counts and appears nowhere in the Explorer's tag tree (#2397).
  // No-ops (no `dataLakes` round trip) when `params.tags` carries no `datalake:*` meta-tag.
  const tags = params.tags === undefined ? undefined : await reconcileDataLakeFallbackTags(params.tags, { db, logger });

  const ext = getFileExtension(params.fileName);
  // Storable is a superset of ingestable: audio (TTS / sound effects) is kept
  // and browsable but never chunked/vectorized or attached to an LLM.
  const { mimeType, supported } = resolveSupportedMimeType(params.fileName, params.mimeType, {
    isAcceptable: isStorableFabFileMimeType,
    precedence: mimeTypePrecedence,
    extensionlessFallback: SupportedFabFileMimeTypes.TXT_PLAIN,
  });

  if (!supported) {
    throw new BadRequestError(`File type ${mimeType || (ext ? `.${ext}` : 'unknown')} is not supported`);
  }

  let filePath = params.prefix ? `${params.prefix}/` : '';
  filePath += `${uuidv4()}${ext ? `.${ext}` : '.txt'}`; // Ensure file has an extension for storage

  const maxFileSize = getSettingsValue('MaxFileSize', await getSettingsMap(db), MAX_FILE_SIZE_DEFAULT_MB) * 1024 * 1024;

  if (params.fileSize >= maxFileSize) throw new BadRequestError('File size exceeds maximum file size');

  // Check storage limit - use organization limit if organizationId is provided
  await checkStorageLimitForFile(user, params.fileSize, params.organizationId, db.organizations?.findById);

  const buildData: Omit<IFabFileDocument, 'id'> = {
    userId,
    ...params,
    ...(tags !== undefined && { tags }),
    ...(provenance && {
      sourceType: provenance.sourceType,
      ...(provenance.sourceMetadata && { sourceMetadata: provenance.sourceMetadata }),
    }),
    mimeType,
    filePath,
    users: [],
    groups: [],
    isGlobalRead: false,
    isGlobalWrite: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  if (params.content) {
    await storage.upload(filePath, params.content, {
      ContentType: params.contentType,
      ContentLength: params.fileSize,
    });
    // This is server-side ingestion with the bytes already in hand,
    // so historically we minted a working GET url immediately. For an image, that url is
    // servable before the async S3 objectCreated scan has had a chance to run, i.e. before
    // moderationStatus (schema default 'pending') can be trusted - isImageServeable() fails
    // closed on 'pending'/'blocked'. So for images we leave fileUrl unset here; the scan sets
    // moderationStatus to 'clean'/'blocked', and a url is only ever minted on read once clean
    // (see fabFileService/get.ts generateSignedUrl). Non-image content is unaffected.
    if (!mimeType.startsWith('image/')) {
      buildData.fileUrl = await storage.generateSignedUrl(filePath, DEFAULT_EXPIRE_IN_SECONDS, 'get');
      buildData.fileUrlExpireAt = new Date(Date.now() + DEFAULT_EXPIRE_IN_SECONDS * 1000);
    }
  } else {
    buildData.presignedUrl = await storage.generateSignedUrl(filePath, 600, 'put');
  }

  const result = await db.fabFiles.create(buildData);

  return result;
};
