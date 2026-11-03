import { Logger } from '@bike4mind/observability';
import type { ClaimResult, TicketPreview } from './bedrocknewsTickets';

const TICKET_BODY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export const ticketFromBody = (body: unknown): string | null => {
  const ticket = (body as { ticket?: unknown } | null | undefined)?.ticket;
  return typeof ticket === 'string' && TICKET_BODY_PATTERN.test(ticket) ? ticket : null;
};

// A bad partner key or missing config is ours to fix; the browser only ever sees "unavailable".
export function warnIfOperatorFault(route: string, code: string) {
  if (code === 'PARTNER_KEY_INVALID' || code === 'NOT_CONFIGURED') {
    Logger.warn(`[partners] bedrocknews claim ${route} cannot reach BedrockNews`, { code });
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

export const isClaimResult = (value: unknown): value is ClaimResult =>
  isRecord(value) && Array.isArray(value.claimed) && typeof value.total === 'number';

export const isTicketPreview = (value: unknown): value is TicketPreview =>
  isRecord(value) &&
  ['open', 'redeeming', 'redeemed', 'expired'].includes(value.status as string) &&
  Array.isArray(value.rungs) &&
  value.rungs.every(
    rung => isRecord(rung) && [5, 6, 7].includes(rung.length as number) && typeof rung.hard === 'boolean'
  ) &&
  (value.result === undefined || isClaimResult(value.result));

export function warnMalformed(route: string) {
  Logger.warn(`[partners] bedrocknews claim ${route} got a malformed success body`);
}
