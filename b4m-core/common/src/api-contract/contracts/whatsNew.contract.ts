import { defineEndpoint } from '../defineEndpoint';
import { PaginationQuerySchema, paginatedResponseSchema } from '../../schemas/pagination';
import { PublicReleaseNoteSchema, ReleaseNoteMediaParamsSchema } from '../../schemas/releaseNotes';
import { ApiErrorSchema } from '../../schemas/chat';

/** Contract for GET /api/v1/whats-new, served by apps/client/pages/api/v1/whats-new.ts. */
export const listWhatsNewContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/whats-new',
  operationId: 'listWhatsNew',
  summary: 'List release notes',
  description:
    'Lists published release notes, newest first. Public: no credentials are needed, and the response ' +
    'is cacheable for up to about 15 minutes (5 fresh plus 10 stale-while-revalidate), so a newly ' +
    'published or withdrawn note can take that long to show. A deployment that proxies an upstream feed ' +
    "stacks its own caching on the upstream's, so there it can take about 31 minutes. Cursor-paginated (see the pagination convention): pass `next_cursor` back as `cursor` until " +
    'it is `null`. Rate limited per client IP.',
  tags: ['Release notes'],
  auth: 'public',
  queryParams: PaginationQuerySchema,
  responses: {
    200: {
      description: 'One page of published release notes, newest first by `published_at`.',
      schema: paginatedResponseSchema(PublicReleaseNoteSchema),
    },
    422: {
      description:
        '`limit` is out of range, or `cursor` is malformed or was issued by a different endpoint. A ' +
        'cursor is opaque: pass back exactly the `next_cursor` you were given. On a deployment that proxies an ' +
        'upstream feed, a cursor issued by that upstream which can no longer be served there ends the list ' +
        '(200 with empty `data`) rather than returning 422.',
      schema: ApiErrorSchema,
    },
    429: { description: 'Per-IP rate limit exceeded.', schema: ApiErrorSchema },
    500: { description: 'Unexpected server error.', schema: ApiErrorSchema },
  },
});

/**
 * Contract for GET /api/v1/whats-new/media/{id}/{asset}, served by
 * apps/client/pages/api/v1/whats-new/media/[id]/[asset].ts. The 10 minutes and 1 hour below must stay in
 * sync with that route's CACHE_CONTROL and SIGNED_URL_TTL_SECONDS.
 */
export const getWhatsNewMediaContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/whats-new/media/{id}/{asset}',
  operationId: 'getWhatsNewMedia',
  summary: 'Get release note media',
  description:
    'Redirects to one file of a published release note video or still image: `landscape` and `portrait` ' +
    'are the 16:9 and 9:16 MP4s, the `-poster` assets their still images, and `image-landscape` and ' +
    "`image-portrait` the 16:9 and 9:16 still images of the note's `image`. The `video` and `image` URLs " +
    'that listWhatsNew returns for uploaded files point here, so a browser can use them as `src` and ' +
    '`poster` as they are. Public: no ' +
    'credentials are needed, and the note must be one listWhatsNew would show. The redirect is cacheable ' +
    'for up to 10 minutes and its target is signed for 1 hour, longer than that, so follow it rather ' +
    'than storing the target. Rate limited per client IP.',
  tags: ['Release notes'],
  auth: 'public',
  pathParams: ReleaseNoteMediaParamsSchema,
  responses: {
    303: {
      description: '`Location` is a time-limited signed GET for the file.',
      noBody: true,
      headers: { Location: 'Signed URL of the file.' },
    },
    404: {
      description:
        'No published note has this id, or the note has no such file, or the file is not an upload this ' +
        'deployment serves (a linked URL is listed as is, not through this route).',
      schema: ApiErrorSchema,
    },
    429: { description: 'Per-IP rate limit exceeded.', schema: ApiErrorSchema },
    500: { description: 'Unexpected server error.', schema: ApiErrorSchema },
  },
});
