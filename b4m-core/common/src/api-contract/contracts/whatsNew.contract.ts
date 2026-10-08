import { defineEndpoint } from '../defineEndpoint';
import { PaginationQuerySchema, paginatedResponseSchema } from '../../schemas/pagination';
import { PublicReleaseNoteSchema } from '../../schemas/releaseNotes';
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
    'published or withdrawn note can take that long to show. Cursor-paginated (see the pagination convention): pass `next_cursor` back as `cursor` until ' +
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
        'cursor is opaque: pass back exactly the `next_cursor` you were given.',
      schema: ApiErrorSchema,
    },
    429: { description: 'Per-IP rate limit exceeded.', schema: ApiErrorSchema },
    500: { description: 'Unexpected server error.', schema: ApiErrorSchema },
  },
});
