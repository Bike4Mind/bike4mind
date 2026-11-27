import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
import {
  CreatePublishedPageCommentRequestSchema,
  CreatePublishedPageShareLinkRequestSchema,
  CreatePublishedPageUploadRequestSchema,
  CreatedPublishedPageShareLinkSchema,
  DownloadPublishedPageFileQuerySchema,
  ListPublishedPageCommentsResponseSchema,
  ListPublishedPageShareLinksResponseSchema,
  ListPublishedPagesQuerySchema,
  ListPublishedPagesResponseSchema,
  PublishedPageCommentParamSchema,
  PublishedPageCommentSchema,
  PublishedPageDraftParamSchema,
  PublishedPageIdParamSchema,
  PublishedPageResourceSchema,
  PublishedPageShareLinkParamSchema,
  PublishedPageUploadResourceSchema,
  RestorePublishedPageRequestSchema,
  UpdatePublishedPageCommentRequestSchema,
  UpdatePublishedPageRequestSchema,
} from '../../schemas/publishedPagePublic';
import { z } from 'zod';
import { ACCOUNT_SUSPENDED_ERROR_CODE, ACCOUNT_TRUST_REQUIRED_ERROR_CODE } from '../../apiErrorCodes';
import { ApiErrorSchema, ScopeForbiddenErrorSchema } from '../../schemas/chat';
import { PaginationQuerySchema } from '../../schemas/pagination';

/**
 * Published pages (a bundle published as a web page) for integrators. New `/api/v1` routes next to the
 * SPA's camelCase `/api/publish/*`; both doors call the same services, so access rules cannot drift.
 *
 * Every operation needs `artifacts:publish`, the scope that already guards publishing a notebook
 * artifact. Share-link reads never return a token: the full URL is in the create response only.
 */
const SCOPES = [ApiKeyScope.ARTIFACTS_PUBLISH];
/** Scope and suspension refusals, plus the outbound-action trust refusal (`assertOutboundActionAllowed`). */
const PublishForbiddenErrorSchema = ScopeForbiddenErrorSchema.extend({
  errorCode: z.enum([ACCOUNT_SUSPENDED_ERROR_CODE, ACCOUNT_TRUST_REQUIRED_ERROR_CODE]).optional(),
  trustReason: z.string().optional(),
  trustedAfter: z.string().optional(),
});
const TRUST_403 =
  'The API key lacks `artifacts:publish` (scope error body), or the account may not use this action yet: ' +
  '`errorCode: account_trust_required` (new or unverified account, with `trustReason` and `trustedAfter`) or an ' +
  'administrator restriction.';
const FORBIDDEN = { description: 'The API key lacks `artifacts:publish`.', schema: ScopeForbiddenErrorSchema } as const;
const FORBIDDEN_OR_TRUST = { description: TRUST_403, schema: PublishForbiddenErrorSchema } as const;
const FORBIDDEN_PATCH = {
  description:
    TRUST_403 +
    ' Making a page more visible can also be refused by an organization sharing policy, such as blocked public links.',
  schema: PublishForbiddenErrorSchema,
} as const;
const RATE_LIMITED = { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema } as const;
const INVALID = { description: 'The request failed validation.', schema: ApiErrorSchema } as const;
const AUTHOR_ONLY =
  'The API key lacks `artifacts:publish` (scope error body), or the caller may not change this comment: only its ' +
  'author may edit the text, and only its author, the page owner or an admin may resolve or delete it.';
const AUTHOR_OR_TRUST = {
  description: AUTHOR_ONLY + ' An edit can also be refused for the account trust or administrator restriction reasons.',
  schema: PublishForbiddenErrorSchema,
} as const;
const NOT_YOURS = {
  description:
    'No page with that id is managed by the caller. A page that does not exist, a deleted one and one you do ' +
    'not own are all reported as 404, so ids cannot be probed.',
  schema: ApiErrorSchema,
} as const;

const PAGE_EXAMPLE = {
  public_id: 'k3x9d2',
  url: 'https://example.com/p/u/<user>/q3-report',
  tier: 'user',
  scope_id: '<userId>',
  slug: 'q3-report',
  title: 'Q3 report',
  description: null,
  tags: ['finance'],
  visibility: 'private',
  comment_policy: 'none',
  discoverable: false,
  embed_origins: [],
  access_gate: null,
  size_bytes: 20480,
  file_count: 3,
  published_at: '2026-10-01T12:00:00.000Z',
  updated_at: '2026-10-01T12:00:00.000Z',
};

const COMMENT_EXAMPLE = {
  id: '<commentId>',
  author_display_name: 'Ada',
  body: 'Looks right.',
  anchor: null,
  thread_root_id: null,
  artifact_version_sha: null,
  resolved_at: null,
  created_at: '2026-10-02T09:30:00.000Z',
};

const TAGS = ['Published pages'];

export const createPublishedPageUploadContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/published-pages/uploads',
  operationId: 'createPublishedPageUpload',
  summary: 'Start a published-page upload',
  description:
    'Step 1 of publishing a bundle. Validates the scope, visibility and file list, and returns a `draft_id` with ' +
    'one presigned upload URL per file. PUT each file to its URL, then call `finalize`. Drafts expire after ' +
    'a short time. Republishing an existing slug you own replaces its content.',
  tags: TAGS,
  auth: 'apiKeyOrJwt',
  scopes: SCOPES,
  request: CreatePublishedPageUploadRequestSchema,
  emitsRateLimitHeaders: true,
  responses: {
    201: {
      description: 'The draft and its upload URLs.',
      schema: PublishedPageUploadResourceSchema,
      example: {
        draft_id: '5b1f6a0e-0000-4000-8000-000000000000',
        upload_urls: [
          { path: 'index.html', url: 'https://storage.example.com/<signed>', expires_at: '2026-10-01T12:10:00.000Z' },
        ],
      },
    },
    403: FORBIDDEN_OR_TRUST,
    422: {
      description:
        'The body failed validation, the file list breaks the bundle limits, the visibility or embed origins are not allowed, or the publish quota is used up.',
      schema: ApiErrorSchema,
    },
    409: { description: 'The slug is published by another user.', schema: ApiErrorSchema },
    429: RATE_LIMITED,
  },
  codeSample: {
    authToken: 'b4m_live_<key>',
    streaming: false,
    body: {
      tier: 'user',
      scope_id: '<userId>',
      slug: 'q3-report',
      title: 'Q3 report',
      files: [{ path: 'index.html', size: 1024, mime_type: 'text/html' }],
    },
  },
});

export const finalizePublishedPageContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/published-pages/uploads/{draft_id}/finalize',
  operationId: 'finalizePublishedPage',
  summary: 'Finalize a published-page upload',
  description:
    'Step 3 of publishing a bundle. Verifies every uploaded file, validates `index.html` and promotes the draft to ' +
    'the live page. Returns the page, or 422 with the validation `violations`.',
  tags: TAGS,
  auth: 'apiKeyOrJwt',
  scopes: SCOPES,
  pathParams: PublishedPageDraftParamSchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'The published page.', schema: PublishedPageResourceSchema, example: PAGE_EXAMPLE },
    403: FORBIDDEN_OR_TRUST,
    404: {
      description: 'The draft does not exist, has expired, or was not created by the caller.',
      schema: ApiErrorSchema,
    },
    409: { description: 'The slug was published by another request.', schema: ApiErrorSchema },
    422: { description: 'A file is missing or does not match, or the page failed validation.', schema: ApiErrorSchema },
    429: RATE_LIMITED,
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});

export const listPublishedPagesContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/published-pages',
  operationId: 'listPublishedPages',
  summary: 'List your published pages',
  description:
    'Lists the pages you have published, most recently published first. Cursor-paginated: pass `next_cursor` back as `cursor` until it is `null`.',
  tags: TAGS,
  auth: 'apiKeyOrJwt',
  scopes: SCOPES,
  queryParams: ListPublishedPagesQuerySchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: {
      description: 'One page of published pages.',
      schema: ListPublishedPagesResponseSchema,
      example: { data: [PAGE_EXAMPLE], next_cursor: null },
    },
    403: FORBIDDEN,
    422: { description: '`limit` is out of range, or `cursor` is malformed.', schema: ApiErrorSchema },
    429: RATE_LIMITED,
  },
});

export const getPublishedPageContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/published-pages/{public_id}',
  operationId: 'getPublishedPage',
  summary: 'Get a published page',
  description: 'Returns the management metadata of a page you own.',
  tags: TAGS,
  auth: 'apiKeyOrJwt',
  scopes: SCOPES,
  pathParams: PublishedPageIdParamSchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'The page.', schema: PublishedPageResourceSchema, example: PAGE_EXAMPLE },
    403: FORBIDDEN,
    404: NOT_YOURS,
    429: RATE_LIMITED,
  },
});

export const updatePublishedPageContract = defineEndpoint({
  method: 'patch',
  path: '/api/v1/published-pages/{public_id}',
  operationId: 'updatePublishedPage',
  summary: 'Update a published page',
  description:
    'Changes the title, description, tags, visibility, comment policy, discoverability, access gate or embed origins. Fields you omit are unchanged.',
  tags: TAGS,
  auth: 'apiKeyOrJwt',
  scopes: SCOPES,
  pathParams: PublishedPageIdParamSchema,
  request: UpdatePublishedPageRequestSchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'The updated page.', schema: PublishedPageResourceSchema, example: PAGE_EXAMPLE },
    403: FORBIDDEN_PATCH,
    404: NOT_YOURS,
    422: {
      description:
        'The body failed validation, or the change breaks a publishing rule (an access gate needs a public page or a share link, embed origins need a public page).',
      schema: ApiErrorSchema,
    },
    429: RATE_LIMITED,
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: { visibility: 'organization' } },
});

export const deletePublishedPageContract = defineEndpoint({
  method: 'delete',
  path: '/api/v1/published-pages/{public_id}',
  operationId: 'deletePublishedPage',
  summary: 'Delete a published page',
  description: 'Takes the page down. Its share links stop working.',
  tags: TAGS,
  auth: 'apiKeyOrJwt',
  scopes: SCOPES,
  pathParams: PublishedPageIdParamSchema,
  emitsRateLimitHeaders: true,
  responses: {
    204: { description: 'The page was deleted.', noBody: true },
    403: FORBIDDEN,
    404: NOT_YOURS,
    429: RATE_LIMITED,
  },
});

export const listPublishedPageShareLinksContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/published-pages/{public_id}/share-links',
  operationId: 'listPublishedPageShareLinks',
  summary: 'List share links',
  description:
    'Lists the live no-sign-in share links of a page in id order (approximately creation order). Cursor-paginated like other lists. A link is identified by `id` and a 4-character `token_hint`; ' +
    'the token and URL are never returned here. The URL is returned once, when the link is created.',
  tags: TAGS,
  auth: 'apiKeyOrJwt',
  scopes: SCOPES,
  pathParams: PublishedPageIdParamSchema,
  queryParams: PaginationQuerySchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: {
      description: 'The live share links.',
      schema: ListPublishedPageShareLinksResponseSchema,
      example: {
        data: [
          {
            id: '<linkId>',
            token_hint: 'a1b2',
            created_at: '2026-10-01T12:00:00.000Z',
            expires_at: null,
            view_count: 3,
            last_viewed_at: '2026-10-02T09:30:00.000Z',
          },
        ],
        next_cursor: null,
      },
    },
    403: FORBIDDEN,
    404: NOT_YOURS,
    422: { description: '`limit` is out of range, or `cursor` is malformed.', schema: ApiErrorSchema },
    429: RATE_LIMITED,
  },
});

export const createPublishedPageShareLinkContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/published-pages/{public_id}/share-links',
  operationId: 'createPublishedPageShareLink',
  summary: 'Create a share link',
  description:
    'Mints a no-sign-in share link alongside the existing ones and returns its absolute URL. This is the only time ' +
    'the URL is returned. A page holds a limited number of live links.',
  tags: TAGS,
  auth: 'apiKeyOrJwt',
  scopes: SCOPES,
  pathParams: PublishedPageIdParamSchema,
  request: CreatePublishedPageShareLinkRequestSchema,
  emitsRateLimitHeaders: true,
  responses: {
    201: {
      description: 'The new link.',
      schema: CreatedPublishedPageShareLinkSchema,
      example: { id: '<linkId>', share_url: 'https://example.com/a/<token>', expires_at: null },
    },
    403: FORBIDDEN_OR_TRUST,
    404: NOT_YOURS,
    409: { description: 'A concurrent change raced this one. Retry.', schema: ApiErrorSchema },
    422: {
      description: 'The body failed validation, `expires_at` is out of range, or the page is at its live-link limit.',
      schema: ApiErrorSchema,
    },
    429: RATE_LIMITED,
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});

export const revokePublishedPageShareLinkContract = defineEndpoint({
  method: 'delete',
  path: '/api/v1/published-pages/{public_id}/share-links/{link_id}',
  operationId: 'revokePublishedPageShareLink',
  summary: 'Revoke a share link',
  description: 'Revokes one share link by id. Its URL stops working.',
  tags: TAGS,
  auth: 'apiKeyOrJwt',
  scopes: SCOPES,
  pathParams: PublishedPageShareLinkParamSchema,
  emitsRateLimitHeaders: true,
  responses: {
    204: { description: 'The link was revoked.', noBody: true },
    403: FORBIDDEN,
    404: { description: 'No such page of yours, or no live link with that id.', schema: ApiErrorSchema },
    409: {
      description:
        'A concurrent change raced this one (retry), or revoking the last link would leave an access-gated page unreachable.',
      schema: ApiErrorSchema,
    },
    429: RATE_LIMITED,
  },
});

export const restorePublishedPageVersionContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/published-pages/{public_id}/restore',
  operationId: 'restorePublishedPageVersion',
  summary: 'Restore an earlier version',
  description:
    "Rolls the page's `index.html` back to a prior version (the previous one by default) as a new current version. " +
    'The version it replaces is archived, so a restore can itself be undone. Only `index.html` is restored.',
  tags: TAGS,
  auth: 'apiKeyOrJwt',
  scopes: SCOPES,
  pathParams: PublishedPageIdParamSchema,
  request: RestorePublishedPageRequestSchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'The restored page.', schema: PublishedPageResourceSchema, example: PAGE_EXAMPLE },
    403: FORBIDDEN_OR_TRUST,
    404: NOT_YOURS,
    409: {
      description: 'A revision is in progress, or the earlier content was never archived.',
      schema: ApiErrorSchema,
    },
    422: {
      description: 'There is no previous version, or the restored page failed validation.',
      schema: ApiErrorSchema,
    },
    429: RATE_LIMITED,
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});

export const listPublishedPageCommentsContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/published-pages/{public_id}/comments',
  operationId: 'listPublishedPageComments',
  summary: 'List comments',
  description:
    'Lists the comments on a page you manage, oldest first. Cursor-paginated: pass `next_cursor` back as `cursor` until it is `null`.',
  tags: TAGS,
  auth: 'apiKeyOrJwt',
  scopes: SCOPES,
  pathParams: PublishedPageIdParamSchema,
  queryParams: PaginationQuerySchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: {
      description: 'The comments.',
      schema: ListPublishedPageCommentsResponseSchema,
      example: { data: [COMMENT_EXAMPLE], next_cursor: null },
    },
    403: FORBIDDEN,
    404: NOT_YOURS,
    422: { description: '`limit` is out of range, or `cursor` is malformed.', schema: ApiErrorSchema },
    429: RATE_LIMITED,
  },
});

export const createPublishedPageCommentContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/published-pages/{public_id}/comments',
  operationId: 'createPublishedPageComment',
  summary: 'Add a comment',
  description: "Adds a comment to a page you manage. The page's comment policy must allow it.",
  tags: TAGS,
  auth: 'apiKeyOrJwt',
  scopes: SCOPES,
  pathParams: PublishedPageIdParamSchema,
  request: CreatePublishedPageCommentRequestSchema,
  emitsRateLimitHeaders: true,
  responses: {
    201: { description: 'The comment.', schema: PublishedPageCommentSchema, example: COMMENT_EXAMPLE },
    403: FORBIDDEN_OR_TRUST,
    404: NOT_YOURS,
    422: INVALID,
    429: RATE_LIMITED,
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: { body: 'Looks right.' } },
});

export const updatePublishedPageCommentContract = defineEndpoint({
  method: 'patch',
  path: '/api/v1/published-pages/{public_id}/comments/{comment_id}',
  operationId: 'updatePublishedPageComment',
  summary: 'Edit or resolve a comment',
  description: 'Edits the text of a comment or resolves or reopens it.',
  tags: TAGS,
  auth: 'apiKeyOrJwt',
  scopes: SCOPES,
  pathParams: PublishedPageCommentParamSchema,
  request: UpdatePublishedPageCommentRequestSchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'The comment.', schema: PublishedPageCommentSchema, example: COMMENT_EXAMPLE },
    403: AUTHOR_OR_TRUST,
    404: { description: 'No such page of yours, or no such comment.', schema: ApiErrorSchema },
    422: INVALID,
    429: RATE_LIMITED,
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: { resolved: true } },
});

export const deletePublishedPageCommentContract = defineEndpoint({
  method: 'delete',
  path: '/api/v1/published-pages/{public_id}/comments/{comment_id}',
  operationId: 'deletePublishedPageComment',
  summary: 'Delete a comment',
  description: 'Deletes a comment.',
  tags: TAGS,
  auth: 'apiKeyOrJwt',
  scopes: SCOPES,
  pathParams: PublishedPageCommentParamSchema,
  emitsRateLimitHeaders: true,
  responses: {
    204: { description: 'The comment was deleted.', noBody: true },
    403: { description: AUTHOR_ONLY, schema: ApiErrorSchema },
    404: { description: 'No such page of yours, or no such comment.', schema: ApiErrorSchema },
    429: RATE_LIMITED,
  },
});

export const downloadPublishedPageFileContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/published-pages/{public_id}/files/download',
  operationId: 'downloadPublishedPageFile',
  summary: 'Download a page file',
  description:
    'Redirects (303) to a short-lived signed URL for one file of a page you manage. Follow the `Location` header ' +
    'immediately; it is not meant to be stored.',
  tags: TAGS,
  auth: 'apiKeyOrJwt',
  scopes: SCOPES,
  pathParams: PublishedPageIdParamSchema,
  queryParams: DownloadPublishedPageFileQuerySchema,
  emitsRateLimitHeaders: true,
  responses: {
    303: {
      description: 'Redirect to the signed file URL.',
      noBody: true,
      headers: { Location: 'The short-lived signed URL of the file.' },
    },
    403: FORBIDDEN,
    404: { description: 'No such page of yours, or no such file in it.', schema: ApiErrorSchema },
    422: INVALID,
    429: RATE_LIMITED,
    503: { description: 'Storage could not mint a signed link right now. Retry.', schema: ApiErrorSchema },
  },
});
