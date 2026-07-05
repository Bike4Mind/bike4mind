/**
 * GET /api/agent-executions - paginated, filterable list of the requesting
 * user's past agent runs, used by the Execution History viewer.
 *
 * Returns top-level executions only (synchronous in-process subagents are
 * hidden - they surface inside their parent's trace; background children are
 * included since they're independently billed). The list endpoint returns a
 * lean projection - `checkpoint`, `iterationBilling`, and the full trace are
 * loaded on demand via `GET /api/agent-executions/[id]` when a row expands.
 *
 * Cursor pagination via the `before` query param (the previous page's last
 * `createdAt`). Backed by the `{ userId: 1, createdAt: -1 }` index.
 */

import type { Request } from 'express';
import { z } from 'zod';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, UnauthorizedError } from '@server/utils/errors';
import { agentExecutionRepository, AGENT_EXECUTION_STATUSES, type AgentExecutionStatus } from '@bike4mind/database';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

const statusSchema = z.enum(AGENT_EXECUTION_STATUSES);

const listQuerySchema = z.object({
  // Express parses repeated query params as arrays; single values stay strings.
  // Normalize both shapes via `union` + an array preprocessor.
  status: z.preprocess(v => (v == null ? undefined : Array.isArray(v) ? v : [v]), z.array(statusSchema).optional()),
  model: z.preprocess(v => (v == null ? undefined : Array.isArray(v) ? v : [v]), z.array(z.string()).optional()),
  minCredits: z.coerce.number().nonnegative().optional(),
  maxCredits: z.coerce.number().nonnegative().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  // Opaque keyset cursor returned by a previous page (`nextCursor`). Format is
  // `<isoCreatedAt>_<objectId>` - validated by the repo, which gracefully
  // ignores malformed values rather than 400-ing.
  before: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).optional(),
});

/**
 * Strip the trailing `[]` from bracket-encoded array keys before Zod parsing.
 *
 * Axios serializes arrays as `key[]=v1&key[]=v2` (`qs` with `arrayFormat:
 * 'brackets'`, configured globally in `ApiContext.tsx`). Next.js's pages-API
 * `req.query` parser does NOT collapse the bracket suffix back into the bare
 * key - it stores the literal key `"key[]"` instead. Without this
 * normalization the Zod schema looks up `status`/`model`, finds `undefined`,
 * and the optional preprocessors silently drop the filter, returning rows
 * that don't match the user's selection. Real bug observed on the preview
 * env: selecting "Running" returned a `completed` execution.
 *
 * The bracket-suffixed key always wins when both forms are present so a
 * future migration to a non-bracket serializer is a no-op.
 */
function normalizeBracketKeys(query: Request['query']): Record<string, unknown> {
  const out: Record<string, unknown> = { ...query };
  for (const key of Object.keys(query)) {
    if (key.endsWith('[]')) {
      out[key.slice(0, -2)] = query[key];
      delete out[key];
    }
  }
  return out;
}

const handler = baseApi().get(async (req: Request, res) => {
  const userId = req.user?.id;
  if (!userId) {
    throw new UnauthorizedError('Authentication required');
  }

  const parsed = listQuerySchema.safeParse(normalizeBracketKeys(req.query));
  if (!parsed.success) {
    throw new BadRequestError(`Invalid query: ${parsed.error.message}`);
  }
  const q = parsed.data;

  if (q.minCredits != null && q.maxCredits != null && q.minCredits > q.maxCredits) {
    throw new BadRequestError('minCredits cannot exceed maxCredits');
  }
  if (q.from && q.to && new Date(q.from) > new Date(q.to)) {
    throw new BadRequestError('from cannot be after to');
  }

  const { items, nextCursor } = await agentExecutionRepository.findByUserIdPaginated(
    userId,
    {
      statuses: q.status as AgentExecutionStatus[] | undefined,
      models: q.model,
      minCredits: q.minCredits,
      maxCredits: q.maxCredits,
      fromDate: q.from ? new Date(q.from) : undefined,
      toDate: q.to ? new Date(q.to) : undefined,
    },
    {
      limit: q.limit ?? DEFAULT_LIMIT,
      before: q.before,
    }
  );

  return res.json({ items, nextCursor });
});

export default handler;
