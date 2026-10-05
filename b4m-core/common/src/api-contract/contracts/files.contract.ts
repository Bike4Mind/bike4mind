import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
import {
  CreateFileUploadRequestSchema,
  CreateFileUploadResponseSchema,
  FileIdParamSchema,
  FileResponseSchema,
} from '../../schemas/publicFile';
import { ApiErrorSchema } from '../../schemas/chat';

/**
 * File upload and read-back for integrators - the input half of any flow that takes a file id
 * (reference images, knowledge files) and the output half of any that returns one.
 *
 * New `/api/v1` routes rather than contracts wrapped around the SPA-internal
 * `/api/files/generate-presigned-url` and `/api/files/{id}`: those return the internal FabFile
 * shape, and LEGACY_PUBLIC_PATHS is frozen. Both doors share their logic with the internal
 * routes (apps/client/server/files/), so the gates cannot drift apart.
 */
export const createFileUploadContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/files',
  operationId: 'createFileUpload',
  summary: 'Start a file upload',
  description:
    'Registers a file and returns a presigned `upload_url`. Uploading is three steps: ' +
    '(1) call this endpoint with the file name, MIME type, and size in bytes; ' +
    '(2) `PUT` the raw bytes to `upload_url` before `upload_url_expires_at` - send no ' +
    '`Authorization` header, the URL signature is the credential, and do send a `Content-Type` ' +
    'matching `mime_type`; (3) poll `GET /api/v1/files/{id}` until `moderation_status` is `clean` ' +
    '(usually a few seconds after the PUT), then pass `id` wherever an endpoint ' +
    'takes a file id (for example `fabFileIds` and `referenceImageFabFileIds` on ' +
    '`POST /api/v1/image-edits`). Unsupported types, a size over the ' +
    'upload limit, or a size that would exceed your storage quota are rejected with 400 before any ' +
    'URL is issued. Authenticate with an API key (`b4m_live_`) carrying `files:write`, or a JWT.',
  tags: ['Files'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.WRITE_FILES],
  request: CreateFileUploadRequestSchema,
  emitsRateLimitHeaders: true,
  requestExample: { file_name: 'reference.png', mime_type: 'image/png', file_size: 482133 },
  responses: {
    201: {
      description: 'The file is registered; PUT its bytes to `upload_url`.',
      schema: CreateFileUploadResponseSchema,
      example: {
        id: '<fileId>',
        upload_url: 'https://<bucket>.s3.amazonaws.com/<key>?X-Amz-Signature=...',
        upload_url_expires_at: '2026-09-29T12:10:00.000Z',
      },
    },
    400: {
      description: 'Unsupported file type, file larger than the upload limit, or storage quota exceeded.',
      schema: ApiErrorSchema,
    },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: {
    authToken: 'b4m_live_<key>',
    streaming: false,
    body: { file_name: 'reference.png', mime_type: 'image/png', file_size: 482133 },
  },
});

export const getFileContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/files/{id}',
  operationId: 'getFile',
  summary: 'Get a file',
  description:
    'Returns a file you own or that has been shared with you, with a short-lived signed ' +
    '`download_url` once it is downloadable. This is both the upload poll (after ' +
    '`POST /api/v1/files`) and the way to fetch any file id another endpoint hands back. ' +
    '`download_url` is `null` until `moderation_status` is `clean`; ' +
    'it expires at `download_url_expires_at`, so re-read this endpoint rather than storing it. ' +
    'Safe (GET) requests are exempt from the per-day API-key quota: a poll consumes no daily ' +
    'slot, and only the per-minute burst limit applies. Authenticate with an API key (`b4m_live_`) ' +
    'carrying `files:read`, or a JWT.',
  tags: ['Files'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.READ_FILES],
  pathParams: FileIdParamSchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: {
      description: 'The file, and a download URL if it is downloadable.',
      schema: FileResponseSchema,
      example: {
        id: '<fileId>',
        file_name: 'reference.png',
        mime_type: 'image/png',
        file_size: 482133,
        moderation_status: 'clean',
        download_url: 'https://<cdn>/<key>?Signature=...',
        download_url_expires_at: '2026-09-30T12:00:00.000Z',
        created_at: '2026-09-29T12:00:00.000Z',
      },
    },
    404: { description: 'No file with that id is visible to the caller.', schema: ApiErrorSchema },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: {
    authToken: 'b4m_live_<key>',
    streaming: false,
    body: {},
  },
});
