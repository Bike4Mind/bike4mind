import { signBrowserFileResponse } from '@server/files/signBrowserFileResponse';
import { z } from 'zod';
import {
  CreateFabFileRequestInputType,
  FabFileSourceType,
  FileEvents,
  MODAL_MEDIA_PREFIX,
  Permission,
  createdFabFileResponseSchema,
} from '@bike4mind/common';
import {
  adminSettingsRepository,
  dataLakeBatchRepository,
  dataLakeRepository,
  dataLakeAccessGrantRepository,
  scopedSettingsRepository,
  organizationRepository,
  FabFile,
  User,
  withTransaction,
} from '@bike4mind/database';
import { dataLakeService, fabFilesService } from '@bike4mind/services';
import { getFileExtension } from '@bike4mind/utils';
import { logEvent } from '@bike4mind/server-utils/utils/analyticsLog';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { respond } from '@server/utils/respond';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { assertDataLakeTagWriteScope } from '@server/dataLakes/dataLakeScopes';
import { BadRequestError, ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { getFilesStorage } from '@bike4mind/server-utils/utils/storage/index';
import { resolveBrowserUploadUrl } from '@server/utils/browserUploadUrl';
import {
  FILES_WRITE_OR_RELEASE_NOTES_SCOPES,
  FILES_WRITE_SCOPES,
  isReleaseNotesOnlyUpload,
} from '@server/files/fileScopes';
import { getS3Url } from '@client/app/utils/s3Url';
import { Resource } from 'sst';
import { persistedIsAdmin, requesterScopedUsers } from '@bike4mind/server-utils/auth/apiKeyAdminScope';

// No caller-chosen `prefix`: the key namespace decides how the S3 upload hook treats an object,
// and a prefix such as `tmp` lands in one it skips (`isUntrackedFabFileKey`), so the object
// would escape the storage charge, size check and moderation. Server-side callers still set it.
const createFabFileSchema = fabFilesService.createFabFileSchema
  .omit({ prefix: true })
  .extend({ purpose: z.literal('modal-media').optional() });

// The What's New media a release-notes key may upload, each type with the extensions that store as it.
// The stored type and key extension come from the file name, so checking the claim alone admits page.html.
const RELEASE_NOTES_MEDIA_EXTENSIONS: ReadonlyMap<string, readonly string[]> = new Map([
  ['video/mp4', ['mp4']],
  ['image/jpeg', ['jpg', 'jpeg']],
  ['image/png', ['png']],
  ['image/webp', ['webp']],
]);
const isReleaseNotesMedia = (params: { mimeType: string; fileName: string }) =>
  RELEASE_NOTES_MEDIA_EXTENSIONS.get(params.mimeType)?.includes(getFileExtension(params.fileName)) ?? false;

// The admin What's New media upload (AdminModalVideoFields) lands under the shared modal prefix, chosen
// here, not by the caller. mp4 stays off the global allowlist (non-image uploads skip the content
// scan), so only that admin upload admits it.
const isModalVideo = (params: { mimeType?: string | null; fileName: string }) =>
  params.mimeType === 'video/mp4' && getFileExtension(params.fileName) === 'mp4';

const handler = baseApi({ requiredScopes: FILES_WRITE_OR_RELEASE_NOTES_SCOPES })
  .use((req, res, next) => {
    if (!req.ability?.can(Permission.create, FabFile)) {
      throw new BadRequestError('Unauthorized');
    }
    next();
  })
  .post(
    asyncHandler<unknown, unknown, CreateFabFileRequestInputType>(async (req, res) => {
      const { user } = req;

      const parsed = createFabFileSchema.parse(req.body);
      const releaseNotesOnly = isReleaseNotesOnlyUpload(req);
      // A release-notes key arrives with the owner's admin role withheld; it still counts when the owner is an admin.
      const adminModalMedia =
        (!!user.isAdmin || (releaseNotesOnly && persistedIsAdmin(user))) && parsed.purpose === 'modal-media';
      if (!adminModalMedia && releaseNotesOnly) {
        throw new ForbiddenError("This API key may only upload What's New media; files:write is required", {
          required_scopes: FILES_WRITE_SCOPES,
        });
      }
      if (releaseNotesOnly && !isReleaseNotesMedia(parsed)) {
        throw new ForbiddenError(
          `This API key may only upload ${[...RELEASE_NOTES_MEDIA_EXTENSIONS.keys()].join(', ')}, named with a matching extension`
        );
      }
      // A release-notes key gets only the fields a What's New video or poster needs.
      const base = releaseNotesOnly
        ? {
            fileName: parsed.fileName,
            mimeType: parsed.mimeType,
            fileSize: parsed.fileSize,
            type: parsed.type,
            ...(parsed.public !== undefined && { public: parsed.public }),
          }
        : parsed;
      const params = adminModalMedia ? { ...base, prefix: MODAL_MEDIA_PREFIX } : base;

      // NOTE: unlike the presign siblings (generate-presigned-url.ts) we do NOT reject executable
      // upload types (html/xhtml/svg) here. Those siblings write to appFilesBucket, which IS routed
      // onto the app origin (see infra/buckets.ts routeBucket) - active content served back from the
      // app origin is stored-XSS, so the gate is required there. This route writes to fabFileBucket,
      // which is routed onto no app origin (it has no routeBucket entry), so anything served from it
      // loads on an isolated S3/CloudFront origin that cannot reach the app's cookies/storage. HTML
      // and text are also normal knowledge-ingestion inputs the session file picker advertises
      // (Session/FilePond.tsx), so gating them here breaks a legitimate path with no app-origin
      // stored-XSS to prevent. The PUT presign is intentionally NOT ContentType-bound (see
      // filesAPICalls.ts createFabFileOnServerWithUpload); the bucket's origin isolation is the
      // boundary, not the declared type.

      // Same effective gate as the presign siblings (generate-presigned-url.ts,
      // generate-presigned-urls-batch.ts): when this create is bound to a data lake batch, the
      // feature must actually be on. Same 403 + FEATURE_DISABLED code, but not identical
      // response shape - this route throws ForbiddenError (rendered by errorHandler as
      // {code, name, error, request_id}), matching generate-presigned-url.ts, while
      // generate-presigned-urls-batch.ts still hand-rolls res.status(403).json({error, code}).
      if (params.batchId) {
        const enabled = await adminSettingsRepository.getSettingsValue('EnableDataLakes');
        if (!enabled) throw new ForbiddenError('Feature not available', { code: 'FEATURE_DISABLED' });
      }

      // Applying a lake's `datalake:*` meta-tag at creation is a WRITE into that lake - gate it so
      // this path can't be used to bypass the Send-to-Data-Lake authorization and inject files into
      // a lake the caller only reads. Full actor (ctx) + the grant repo so a transferred owner /
      // curator / org admin can create-into their lake too, matching the presign doors.
      const requestedTagNames = (params.tags ?? []).map(t => t.name);
      // Covers both membership signals for this new file: a `datalake:*` meta-tag, and a plain
      // content tag matching one of the caller's OWN lakes' `fileTagPrefix` (the prefix arm - see
      // assertDataLakeTagWriteScope's own doc comment). Only the latter needs `user.id` - this
      // file does not exist yet, so it can only ever be a JOIN.
      await assertDataLakeTagWriteScope(req, requestedTagNames, {
        userId: user.id,
        db: { dataLakes: dataLakeRepository },
      });
      const ctx = await toAccessContext(req);
      await dataLakeService.assertCanWriteDataLakeTags(ctx, requestedTagNames, {
        db: {
          dataLakes: dataLakeRepository,
          dataLakeAccessGrants: dataLakeAccessGrantRepository,
          adminSettings: adminSettingsRepository,
          scopedSettings: scopedSettingsRepository,
        },
        // This request creates the file, so the caller is its owner-to-be and the admission
        // contract (#1680) predicts against their chunk policy.
        members: [{ userId: ctx.userId }],
        logger: req.logger,
      });

      // Verify batch ownership before stamping - batchId comes from the body (IDOR otherwise).
      // Shared with the presign routes (see assertBatchOwnership).
      if (params.batchId) {
        await dataLakeService.assertBatchOwnership(user.id, params.batchId, {
          db: { batches: dataLakeBatchRepository },
        });
      }

      const result = await withTransaction(async () => {
        return fabFilesService.createFabFile(user.id, params, {
          db: {
            adminSettings: adminSettingsRepository,
            fabFiles: FabFile,
            users: requesterScopedUsers(req, User),
            organizations: organizationRepository,
            dataLakes: dataLakeRepository,
            // The service re-gates the lake tag internally, so its inputs must stay at least as
            // wide as the route's own prologue above: without the grant repo that re-gate loses
            // the curator and transferred-owner rungs and refuses a caller this route just
            // authorized. Same shape as proposalAdmissionDeps.ts / dataLakeIngestDeps.ts.
            dataLakeAccessGrants: dataLakeAccessGrantRepository,
            scopedSettings: scopedSettingsRepository,
          },
          logger: req.logger,
          storage: {
            upload: async (filepath, content, option) => {
              await getFilesStorage().upload(content, filepath, {
                ContentType: option?.ContentType || 'text/plain',
                ContentLength: option?.ContentLength || Buffer.byteLength(content, 'utf8'),
              });
              return filepath;
            },
            generateSignedUrl: (
              filepath: string,
              expireInSeconds: number,
              mode?: 'get' | 'put',
              options?: { ContentLength?: number }
            ) =>
              getFilesStorage().getSignedUrl(filepath, mode ?? 'get', {
                expiresIn: expireInSeconds,
                ContentLength: options?.ContentLength,
              }),
          },
          // Admission provenance (#1679): a direct-API upload is a manual door. Passed as the
          // server-side `provenance` adapter, never from the request body, so the origin cannot be
          // forged. Not defaulted inside the service - other callers (e.g. research) are not manual.
          provenance: { sourceType: FabFileSourceType.MANUAL_UPLOAD },
          // The other half of the same parity: the grant repo restores the grant rungs, but the
          // org rungs need the actor's administered-org set, which the service cannot read off a
          // user document.
          administeredOrgIds: ctx.administeredOrgIds,
          ...(adminModalMedia && isModalVideo(params) && { mimeTypePrecedence: 'claim-first' as const }),
        });
      });

      await logEvent(
        { userId: user.id, type: FileEvents.CREATE_FILE, metadata: { fileId: result.id } },
        { ability: req.ability }
      );

      // Route the browser's upload via the shared resolver: hosted keeps the direct S3 presign;
      // self-host returns a same-origin proxy (S3/MinIO isn't browser-reachable). Shared with the
      // batch path (generate-presigned-urls-batch) so the two upload entry points can't diverge.
      if (result.presignedUrl) {
        result.presignedUrl = resolveBrowserUploadUrl(result.id, result.presignedUrl);
      }

      const signed = await signBrowserFileResponse(result);
      // Same URL the admin form builds (AdminModalVideoFields), so API-key callers need no bucket name.
      return respond(
        res,
        createdFabFileResponseSchema,
        adminModalMedia && result.filePath
          ? { ...signed, mediaUrl: getS3Url({ bucket: Resource.fabFileBucket.name, key: result.filePath }) }
          : signed
      );
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
