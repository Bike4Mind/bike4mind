// BedrockNews credits a solved Headword rung to a Bike4Mind user. Key-only; amounts, caps and
// idempotency live in server/partners/bedrocknewsPuzzleReward.ts.

import { ApiKeyScope } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { baseApi } from '@server/middlewares/baseApi';
import { buildErrorBody } from '@server/middlewares/errorHandler';
import { grantPuzzleReward } from '@server/partners/bedrocknewsPuzzleReward';
import { fromZodError } from 'zod-validation-error';
import { z } from 'zod';

const MAX_PUZZLE_AGE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const isCalendarDate = (value: string) => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

const bodySchema = z.object({
  userId: z.string().regex(/^[a-f0-9]{24}$/),
  puzzleDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(isCalendarDate, 'Not a calendar date'),
  tier: z.union([z.literal(5), z.literal(6), z.literal(7)]),
  hard: z.boolean(),
});

const REFUSAL_MESSAGES = {
  USER_NOT_FOUND: 'User not found',
  USER_NOT_ELIGIBLE: 'User is not eligible for rewards',
  DAILY_CAP: 'Daily reward cap reached',
  BUDGET_EXHAUSTED: 'Reward budget exhausted',
} as const;

// A code on every refusal lets the caller tell a rejected request from an outage and stop retrying.
const failureBody = (error: string, code: string, requestId: string | undefined) =>
  buildErrorBody({ error, requestId, additionalInfo: { code } });

// Dates compare as ISO strings: puzzleDate is validated as YYYY-MM-DD above.
function isWithinPuzzleWindow(puzzleDate: string, now = Date.now()) {
  const today = new Date(now).toISOString().slice(0, 10);
  const oldest = new Date(now - MAX_PUZZLE_AGE_DAYS * DAY_MS).toISOString().slice(0, 10);
  return puzzleDate >= oldest && puzzleDate <= today;
}

const handler = baseApi({ requiredScopes: [ApiKeyScope.REWARDS_GRANT], allowedMethods: ['POST'] }).post(
  async (req, res) => {
    // The scope gate only runs for key callers, so a session would otherwise reach the payout.
    if (!req.apiKeyInfo) throw new ForbiddenError('API key required');

    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(failureBody(fromZodError(parsed.error).message, 'INVALID', req.requestId));
    }
    const { userId, puzzleDate, tier, hard } = parsed.data;
    if (!isWithinPuzzleWindow(puzzleDate)) {
      return res.status(400).json(failureBody('puzzleDate out of range', 'INVALID', req.requestId));
    }

    const result = await grantPuzzleReward({ userId, puzzleDate, tier, hard });
    if (!result.ok) {
      Logger.info('[partners] headword reward refused', { userId, puzzleDate, tier, code: result.code });
      return res.status(result.status).json(failureBody(REFUSAL_MESSAGES[result.code], result.code, req.requestId));
    }

    const { granted, credits, balance, firstSolveCredits } = result;
    Logger.info('[partners] headword reward', { userId, puzzleDate, tier, granted, credits });
    return res.status(200).json({ granted, credits, balance, firstSolveCredits });
  }
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
