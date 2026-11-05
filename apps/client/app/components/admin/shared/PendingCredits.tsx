import React from 'react';
import { Stack } from '@mui/joy';
import type { AdminSignupGrantPending } from '@bike4mind/common';
import { RelativeTime } from './EntityHeader';
import { Fact } from './SectionCard';
import { StatusChip } from './StatusChip';

const CREDITS = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const credits = (value: number) => CREDITS.format(value);

const STAGE_LABEL: Readonly<Record<NonNullable<AdminSignupGrantPending['stage']>, string>> = {
  pending_email: 'Waiting on email verification',
  signup: 'Signup tranche paid, drip open',
  unlocked: 'Unlocked',
};

const HELD_REASON_LABEL: Readonly<Record<'budget_exhausted' | 'risk_review', string>> = {
  budget_exhausted: 'waiting for the daily pool',
  risk_review: 'waiting on risk review',
};

/** Why an admin action changed nothing, in words an admin can act on. */
const NOOP_COPY: Readonly<Record<string, string>> = {
  no_grant: 'This account has no signup grant.',
  blocked: 'Grants and rewards are blocked for this account.',
  not_blocked: 'This account is not blocked.',
  already_blocked: 'This account is already blocked.',
  not_held: 'No signup grant is held for this account.',
  withheld: 'The held grant is withheld until the account is verified and in good standing.',
  held_for_review: 'Held for risk review. Decide it from the review queue.',
  tranche_pending: 'The first tranche is still pending and is paid before the rest.',
  nothing_remaining: 'Nothing is left to release.',
  not_paid: 'Nothing was paid out.',
};

export const pendingNoopCopy = (reason: string | null | undefined): string =>
  (reason && NOOP_COPY[reason]) || 'Nothing changed.';

/** Chips naming the states that change what an admin should do with the account. */
export const PendingCreditsChips: React.FC<{ pending: AdminSignupGrantPending }> = ({ pending }) => (
  <Stack direction="row" flexWrap="wrap" gap={0.75} data-testid="pending-credits-chips">
    {pending.blocked && <StatusChip tone="bad" dot label="Blocked" data-testid="pending-credits-chip-blocked" />}
    {pending.held && <StatusChip tone="warn" dot label="Held" data-testid="pending-credits-chip-held" />}
    {pending.forfeited && (
      <StatusChip tone="bad" label="Payment unlock forfeited" data-testid="pending-credits-chip-forfeited" />
    )}
    {pending.source === 'package' && (
      <StatusChip tone="info" label="Grant package" data-testid="pending-credits-chip-package" />
    )}
    {!pending.hasGrant && !pending.held && (
      <StatusChip tone="neutral" label="No signup grant" data-testid="pending-credits-chip-no-grant" />
    )}
  </Stack>
);

/**
 * The facts of an account's pending signup credits, as rows of a SectionCard. Shared by the profile Credits tab
 * and any other surface that shows an account's pending state from the same payload.
 */
export const PendingCreditsFacts: React.FC<{ pending: AdminSignupGrantPending }> = ({ pending }) => {
  const { schedule, held, heldUnlock, forfeited, blocked, rewards } = pending;
  return (
    <>
      <Fact label="Stage" data-testid="pending-credits-stage">
        {pending.stage ? STAGE_LABEL[pending.stage] : undefined}
      </Fact>
      {schedule && (
        <>
          <Fact label="Schedule" data-testid="pending-credits-schedule">
            {credits(schedule.signupCredits)} initial, {credits(schedule.dailyCredits)} a day, cap{' '}
            {credits(schedule.dripCap)}
          </Fact>
          <Fact label="Received" data-testid="pending-credits-received">
            {credits(schedule.received)} of {credits(schedule.signupCredits + schedule.unlockCredits)}
          </Fact>
          <Fact label="Remaining to drip" data-testid="pending-credits-drip-remaining">
            {credits(schedule.dripRemaining)}
          </Fact>
          <Fact label="Remaining in grant" data-testid="pending-credits-remaining">
            {credits(schedule.remaining)}
          </Fact>
        </>
      )}
      {held && (
        <Fact label="Held grant" data-testid="pending-credits-held">
          {held.credits > 0 ? `${credits(held.credits)} credits` : 'Amount not recorded'}
          {held.reason ? `, ${HELD_REASON_LABEL[held.reason]}` : ''}
          {held.since && (
            <>
              , since <RelativeTime at={new Date(held.since)} />
            </>
          )}
        </Fact>
      )}
      {heldUnlock && (
        <Fact label="Payment unlock" data-testid="pending-credits-held-unlock">
          Pays <RelativeTime at={new Date(heldUnlock.releaseAt)} />
        </Fact>
      )}
      {forfeited && (
        <Fact label="Forfeited" data-testid="pending-credits-forfeited">
          {forfeited.cause.replace(/_/g, ' ')}
        </Fact>
      )}
      <Fact label="Queued rewards" data-testid="pending-credits-rewards">
        {rewards.queuedCount > 0
          ? `${credits(rewards.queuedCount)} (${credits(rewards.queuedCredits)} credits)`
          : 'None'}
      </Fact>
      {rewards.pausedCount > 0 && (
        <Fact label="Paused rewards" data-testid="pending-credits-paused-rewards">
          {credits(rewards.pausedCount)} ({credits(rewards.pausedCredits)} credits), restored on unblock
        </Fact>
      )}
      <Fact label="Last activity credit" data-testid="pending-credits-last-activity">
        {pending.lastActivityCreditDay}
      </Fact>
      {blocked && (
        <Fact label="Blocked" data-testid="pending-credits-blocked">
          <RelativeTime at={new Date(blocked.at)} />
        </Fact>
      )}
    </>
  );
};
