import { z } from 'zod';
import {
  adminSignupGrantPendingListSchema,
  BadRequestError,
  resolveSignupGrantSchedule,
  type AdminSignupGrantPendingRow,
} from '@bike4mind/common';
import {
  adminSettingsRepository,
  heldCreditRewardRepository,
  signupGrantPendingRepository,
  type SignupGrantPendingCursor,
} from '@bike4mind/database';
import { adminApi } from '@server/middlewares/adminApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { respond } from '@server/utils/respond';

const querySchema = z.object({
  status: z.enum(['held', 'dripping', 'locked', 'blocked']).optional(),
  heldReason: z.enum(['budget_exhausted', 'risk_review']).optional(),
  source: z.enum(['default', 'package']).optional(),
  sort: z.enum(['oldest', 'remaining']).default('oldest'),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const cursorSchema = z.object({
  s: z.enum(['oldest', 'remaining']),
  r: z.number().int().min(0).optional(),
  id: z.string().regex(/^[0-9a-f]{24}$/),
});

const encodeCursor = (sort: 'oldest' | 'remaining', next: SignupGrantPendingCursor) =>
  Buffer.from(JSON.stringify({ s: sort, r: next.remaining, id: next.id })).toString('base64url');

function decodeCursor(raw: string, sort: 'oldest' | 'remaining'): SignupGrantPendingCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new BadRequestError('Invalid cursor');
  }
  const cursor = cursorSchema.safeParse(parsed);
  if (!cursor.success || cursor.data.s !== sort || (sort === 'remaining') !== (cursor.data.r !== undefined)) {
    throw new BadRequestError('Invalid cursor');
  }
  return { id: cursor.data.id, remaining: cursor.data.r };
}

const iso = (value: Date | null | undefined) => (value ? new Date(value).toISOString() : null);

/**
 * GET /api/admin/signup-grants/pending
 *
 * Accounts with signup-grant credits still to come, a held tranche or a block, filtered and sorted server-side
 * with an opaque keyset cursor. Row math matches the profile pending card (signup-grant-pending.ts).
 */
const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { GET: 'credits:adjust' } }).get(
  asyncHandler(async (req, res) => {
    const query = querySchema.safeParse(req.query);
    if (!query.success) throw new BadRequestError('Invalid pending list query');
    const { sort, limit, status, heldReason, source } = query.data;
    const cursor = query.data.cursor ? decodeCursor(query.data.cursor, sort) : undefined;

    const { dripCap } = await resolveSignupGrantSchedule(adminSettingsRepository);
    const page = await signupGrantPendingRepository.listPending({
      dripCap,
      status,
      heldReason,
      source,
      sort,
      cursor,
      limit,
    });
    const rewards = await heldCreditRewardRepository.totalsForUsers(page.rows.map(row => row.id));

    const data = page.rows.map((row): AdminSignupGrantPendingRow => {
      const reward = rewards.get(row.id);
      return {
        id: row.id,
        email: row.email,
        createdAt: iso(row.createdAt),
        source: row.source,
        stage: row.stage,
        status: row.status,
        held: row.heldReason ? { reason: row.heldReason, since: iso(row.heldAt), credits: row.heldCredits } : null,
        blocked: row.status === 'blocked' ? { at: iso(row.blockedAt) } : null,
        remaining: row.remaining,
        dripRemaining: row.dripRemaining,
        rewards: {
          queuedCount: reward?.held.count ?? 0,
          queuedCredits: reward?.held.credits ?? 0,
          pausedCount: reward?.paused.count ?? 0,
          pausedCredits: reward?.paused.credits ?? 0,
        },
      };
    });

    return respond(res, adminSignupGrantPendingListSchema, {
      data,
      nextCursor: page.next ? encodeCursor(sort, page.next) : null,
      viewer: { canRelease: req.user?.isAdmin === true },
    });
  })
);

export const config = { api: { externalResolver: true } };
export default handler;
