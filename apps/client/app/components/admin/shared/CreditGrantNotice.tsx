import React from 'react';
import { Stack, Typography } from '@mui/joy';
import { isAxiosError } from 'axios';
import {
  ADMIN_GRANT_HARD_LIMIT,
  ADMIN_GRANT_IMMEDIATE_LIMIT,
  ADMIN_LARGE_GRANT_PHRASE,
  adminGrantRoom,
  creditsToUsd,
  isGrantLimitRefusal,
} from '@bike4mind/common';
import type { TypedConfirm } from './ActionDialog';

const formatCredits = (credits: number) => credits.toLocaleString('en-US');

const phraseConfirm = (lead: string): TypedConfirm => ({ expected: ADMIN_LARGE_GRANT_PHRASE, noun: 'phrase', lead });

/** The server's figures for one recipient (GET .../recent-credit-grants); a team grant to a new org has received 0. */
export type CreditGrantFigures = { receivedCredits: number; immediateLimit: number };

/**
 * How a grant of `credits` will go, decided before submit from the server's figures, mirroring
 * apps/client/server/admin/creditGrants/tierCap.ts (which still decides):
 * - `routine`: runs at once.
 * - `confirm`: runs at once, after the typed phrase (past ADMIN_GRANT_IMMEDIATE_LIMIT, by an approver).
 * - `approval`: the whole grant becomes one approval request, after the typed phrase. Never split.
 * - `over_limit`: past ADMIN_GRANT_HARD_LIMIT, which approval cannot lift; subscriptions pass `hardLimited: false`.
 * `grantNow` is what may still be granted at once, for a "Grant N now" alternative.
 */
export type CreditGrantPlan =
  | { kind: 'routine' }
  | { kind: 'confirm'; typedConfirm: TypedConfirm }
  | {
      kind: 'approval';
      typedConfirm: TypedConfirm;
      notice: string;
      grantNow: number;
      grantNowNeedsPhrase: boolean;
    }
  | { kind: 'over_limit'; notice: string; grantNow: number; grantNowNeedsPhrase: boolean };

const PHRASE_LEAD = `Grants that take a user above ${formatCredits(ADMIN_GRANT_IMMEDIATE_LIMIT)} credits in 24 hours need a reason and the phrase.`;

export const planCreditGrant = (
  credits: number,
  figures: CreditGrantFigures | undefined,
  { hardLimited = true }: { hardLimited?: boolean } = {}
): CreditGrantPlan => {
  if (credits <= 0) return { kind: 'routine' };
  // Figures not loaded: ask for the phrase whenever it might be needed and let the server decide the rest.
  if (!figures)
    return credits > ADMIN_GRANT_IMMEDIATE_LIMIT
      ? { kind: 'confirm', typedConfirm: phraseConfirm(PHRASE_LEAD) }
      : { kind: 'routine' };

  const room = adminGrantRoom(figures);
  const grantNow = { grantNow: room.immediate, grantNowNeedsPhrase: room.immediate > room.unconfirmed };
  if (hardLimited && credits > room.hard) {
    return {
      kind: 'over_limit',
      notice: `No grant can take this user above ${formatCredits(ADMIN_GRANT_HARD_LIMIT)} credits in 24 hours, approved or not.`,
      ...grantNow,
    };
  }
  if (credits > room.immediate) {
    // Every immediate limit is at least ADMIN_GRANT_IMMEDIATE_LIMIT, so a grant past it always needs the phrase.
    return {
      kind: 'approval',
      typedConfirm: phraseConfirm(PHRASE_LEAD),
      notice: `This takes the user above ${formatCredits(figures.immediateLimit)} admin-granted credits in 24 hours, so the whole grant goes to a senior granter for approval. Nothing is granted until it is approved.`,
      ...grantNow,
    };
  }
  return credits > room.unconfirmed
    ? { kind: 'confirm', typedConfirm: phraseConfirm(PHRASE_LEAD) }
    : { kind: 'routine' };
};

/** The typed phrase a plan asks for; for `over_limit`, only when the "Grant N now" alternative needs it. */
export const planTypedConfirm = (plan: CreditGrantPlan): TypedConfirm | undefined => {
  if (plan.kind === 'confirm' || plan.kind === 'approval') return plan.typedConfirm;
  if (plan.kind === 'over_limit' && plan.grantNow > 0 && plan.grantNowNeedsPhrase) return phraseConfirm(PHRASE_LEAD);
  return undefined;
};

/** A grant-cap refusal (tierCap.ts): the dialog's figures were stale, so it refetches them and re-plans. */
export const isCreditGrantLimitError = (error: unknown): boolean =>
  isAxiosError(error) && isGrantLimitRefusal(error.response?.data);

/** "You are granting $X worth of credits.", plus the approval notice when the plan has one; nothing for no grant. */
export const CreditGrantNotice: React.FC<{ credits: number; plan?: CreditGrantPlan; 'data-testid': string }> = ({
  credits,
  plan,
  'data-testid': testId,
}) =>
  credits > 0 ? (
    <Stack gap={0.5}>
      <Typography level="body-sm" data-testid={testId}>
        You are granting {creditsToUsd(credits)} worth of credits.
      </Typography>
      {plan?.kind === 'approval' && (
        <Typography level="body-sm" color="warning" data-testid={`${testId}-approval`}>
          {plan.notice}
        </Typography>
      )}
    </Stack>
  ) : null;
