import { Logger } from '@bike4mind/observability';
import { PUZZLE_TIERS } from './bedrocknewsPuzzleReward';
import { TICKET_STATUSES, type ClaimResult, type TicketPreview } from './bedrocknewsTickets';

type CommonState = { state: 'verify-email' | 'expired' | 'not-found' | 'in-progress' | 'unavailable' };

export type PreviewState =
  | CommonState
  | { state: 'ready'; credits: number; payable?: number; rungs: TicketPreview['rungs']; account: string }
  | { state: 'redeemed'; result: ClaimResult };

export type RedeemState = CommonState | { state: 'budget-spent' } | { state: 'done'; result: ClaimResult };

type RouteState = { preview: PreviewState; redeem: RedeemState };
type Route = keyof RouteState;

const TICKET_FAILURES: Record<string, CommonState> = {
  TICKET_NOT_FOUND: { state: 'not-found' },
  TICKET_EXPIRED: { state: 'expired' },
};

const REDEEM_FAILURES: Record<string, RedeemState> = {
  ...TICKET_FAILURES,
  B4M_NOT_ELIGIBLE: { state: 'verify-email' },
  CLAIM_IN_PROGRESS: { state: 'in-progress' },
  B4M_BUDGET_SPENT: { state: 'budget-spent' },
};

const FAILURES: { [R in Route]: Record<string, RouteState[R]> } = { preview: TICKET_FAILURES, redeem: REDEEM_FAILURES };
const UNAVAILABLE: CommonState = { state: 'unavailable' };

// A bad partner key or missing config is ours to fix; the browser only ever sees "unavailable".
export function failureState<R extends Route>(route: R, code: string): RouteState[R] {
  if (code === 'PARTNER_KEY_INVALID' || code === 'NOT_CONFIGURED') {
    Logger.warn(`[partners] bedrocknews claim ${route} cannot reach BedrockNews`, { code });
  }
  return FAILURES[route][code] ?? (UNAVAILABLE as RouteState[R]);
}

export function malformedState(route: Route): CommonState {
  Logger.warn(`[partners] bedrocknews claim ${route} got a malformed success body`);
  return UNAVAILABLE;
}

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
