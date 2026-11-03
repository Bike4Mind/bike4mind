import type { Request, Response } from 'express';
import { Logger } from '@bike4mind/observability';
import { currentBalance, findPayableUser, PUZZLE_TIERS } from './bedrocknewsPuzzleReward';
import { TICKET_STATUSES, type ClaimResult, type TicketPreview } from './bedrocknewsTickets';

export type ClaimState =
  | { state: 'ready'; credits: number; rungs: TicketPreview['rungs']; account: string }
  | { state: 'done' | 'redeemed'; result: ClaimResult }
  | { state: 'verify-email' | 'expired' | 'not-found' | 'in-progress' | 'budget-spent' | 'unavailable' };

type Route = 'preview' | 'redeem';

const TICKET_BODY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

const ticketFromBody = (body: unknown): string | null => {
  const ticket = (body as { ticket?: unknown } | null | undefined)?.ticket;
  return typeof ticket === 'string' && TICKET_BODY_PATTERN.test(ticket) ? ticket : null;
};

export async function answerClaim(
  req: Request,
  res: Response,
  run: (ticket: string, user: { id: string; email: string }) => Promise<ClaimState>
) {
  res.setHeader('Cache-Control', 'no-store');
  const ticket = ticketFromBody(req.body);
  if (!ticket) return res.status(400).json({ state: 'not-found' } satisfies ClaimState);

  const user = await findPayableUser(req.user.id);
  const claim: ClaimState = user
    ? await run(ticket, { id: req.user.id, email: user.email })
    : { state: 'verify-email' };
  return res.status(200).json(claim);
}

const TICKET_FAILURES: Record<string, ClaimState> = {
  TICKET_NOT_FOUND: { state: 'not-found' },
  TICKET_EXPIRED: { state: 'expired' },
};

const REDEEM_FAILURES: Record<string, ClaimState> = {
  ...TICKET_FAILURES,
  B4M_NOT_ELIGIBLE: { state: 'verify-email' },
  CLAIM_IN_PROGRESS: { state: 'in-progress' },
  B4M_BUDGET_SPENT: { state: 'budget-spent' },
};

// A bad partner key or missing config is ours to fix; the browser only ever sees "unavailable".
export function failureState(route: Route, code: string): ClaimState {
  if (code === 'PARTNER_KEY_INVALID' || code === 'NOT_CONFIGURED') {
    Logger.warn(`[partners] bedrocknews claim ${route} cannot reach BedrockNews`, { code });
  }
  const known = route === 'redeem' ? REDEEM_FAILURES : TICKET_FAILURES;
  return known[code] ?? { state: 'unavailable' };
}

export function malformedState(route: Route): ClaimState {
  Logger.warn(`[partners] bedrocknews claim ${route} got a malformed success body`);
  return { state: 'unavailable' };
}

// A stored result may carry the balance of whichever account redeemed; show the session user's own.
export const withOwnBalance = async (result: ClaimResult, userId: string): Promise<ClaimResult> => ({
  ...result,
  balance: await currentBalance(userId),
});

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const includes = <T>(list: readonly T[], value: unknown) => list.includes(value as T);

export const isClaimResult = (value: unknown): value is ClaimResult =>
  isRecord(value) &&
  Array.isArray(value.claimed) &&
  typeof value.total === 'number' &&
  typeof value.firstSolveCredits === 'number' &&
  typeof value.capped === 'number';

export const isTicketPreview = (value: unknown): value is TicketPreview =>
  isRecord(value) &&
  includes(TICKET_STATUSES, value.status) &&
  Array.isArray(value.rungs) &&
  value.rungs.every(rung => isRecord(rung) && includes(PUZZLE_TIERS, rung.length) && typeof rung.hard === 'boolean') &&
  (value.result === undefined || isClaimResult(value.result));
