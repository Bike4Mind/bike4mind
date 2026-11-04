import {
  signupActiveSeconds,
  signupGrantDripOpen,
  signupGrantDripRemaining,
  type SignupGrant,
} from '@bike4mind/common';
import { formatCreditBalance } from '@client/app/utils/formatCredits';

export interface StarterPrompt {
  title: string;
  prompt: string;
}

export const STARTER_PROMPTS: readonly StarterPrompt[] = [
  {
    title: 'Plan',
    prompt: 'Help me plan a productive week. Ask me three quick questions about my goals, then draft a schedule.',
  },
  {
    title: 'Write',
    prompt: 'Draft a short, friendly email asking a colleague to move our meeting to next week.',
  },
  {
    title: 'Learn',
    prompt: 'Explain how AI chat assistants like you work, in plain language and under 200 words.',
  },
];

interface WelcomeGateArgs {
  sessionsLoaded: boolean;
  /** Own notebooks on the first page of the sidebar list. */
  sessionCount: number;
  dismissed: boolean;
}

/** Only a user with no notebooks at all sees the welcome; a returning user never does. */
export function shouldShowNewUserWelcome({ sessionsLoaded, sessionCount, dismissed }: WelcomeGateArgs): boolean {
  return sessionsLoaded && sessionCount === 0 && !dismissed;
}

/**
 * A spent balance replaces the composer (CreditsWarning), so "type your own below" and the
 * starters, which send straight away, would lead nowhere.
 */
export function welcomeCanStart({ enforceCredits, balance }: { enforceCredits: boolean; balance: number }): boolean {
  return !(enforceCredits && balance <= 0);
}

interface CreditsLineArgs {
  enforceCredits: boolean;
  balance: number;
  /** Signed up openly and still owes email verification before the starter grant lands. */
  awaitingVerification: boolean;
  /** An explicit grant or the maximum staged entitlement before risk assessment. */
  pendingGrant: number | null;
  pendingGrantIsMaximum?: boolean;
  /** Daily activity drip amount; omitted or 0 when the drip is off. */
  dailyDripCredits?: number;
  /** Raw signupGrantActivityMinActiveSeconds setting; invalid values read as the default. */
  minActiveSeconds?: unknown;
}

/** "5 minutes" style phrase for the active-time minimum, rounded to whole minutes, or tenths of an hour from 60 minutes. */
export function activeTimeCopy(minActiveSeconds: unknown): string {
  const minutes = Math.round(signupActiveSeconds(minActiveSeconds) / 60);
  if (minutes < 60) return `about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `about ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

/**
 * What the next drip would pay: the daily amount, capped by what the live drip cap still leaves after
 * what this account has already dripped. Mirrors the server drip in stagedSignupGrant.ts; 0 when off.
 */
export function advertisedDripCredits({
  dailyCredits,
  dripCap,
  grant,
}: {
  dailyCredits: number;
  dripCap: number;
  grant: (Pick<SignupGrant, 'dripCredits'> & Partial<Pick<SignupGrant, 'stage' | 'unlockedBy'>>) | undefined;
}): number {
  // A verification unlock closes the drip for good; pending_email still advertises what verifying will start.
  if (grant?.stage === 'unlocked' && !signupGrantDripOpen({ stage: grant.stage, unlockedBy: grant.unlockedBy }))
    return 0;
  return dailyCredits > 0 ? Math.min(dailyCredits, signupGrantDripRemaining(grant ?? {}, dripCap)) : 0;
}

/** The self-serve unlock paths we advertise; org invites and admin releases also unlock but are not offered here. */
export function unlockPathsCopy(dailyDripCredits: number, minActiveSeconds?: unknown): string {
  const drip =
    dailyDripCredits > 0
      ? `up to ${formatCreditBalance(dailyDripCredits)} for each day you have Bike4Mind open and in use for ${activeTimeCopy(minActiveSeconds)} (a hidden tab or 5 minutes without input does not count), `
      : '';
  return `The rest unlocks ${drip}all at once when you subscribe, or all at once when you verify a card.`;
}

/**
 * The welcome's credits sentence, or null when there is nothing true to say (credits not
 * enforced, or an empty balance with no pending grant). Numbers come from the live balance or
 * the server setting, never a constant.
 */
export function welcomeCreditsLine({
  enforceCredits,
  balance,
  awaitingVerification,
  pendingGrant,
  pendingGrantIsMaximum = false,
  dailyDripCredits = 0,
  minActiveSeconds,
}: CreditsLineArgs): string | null {
  if (!enforceCredits) return null;
  if (awaitingVerification) {
    return pendingGrant && pendingGrant > 0
      ? pendingGrantIsMaximum
        ? `Verify your email to unlock up to ${formatCreditBalance(pendingGrant)} now. ${unlockPathsCopy(dailyDripCredits, minActiveSeconds)}`
        : `Verify your email to unlock your ${formatCreditBalance(pendingGrant)}.`
      : 'Verify your email to unlock your free credits.';
  }
  if (balance <= 0) return null;
  return `You're starting with ${formatCreditBalance(balance)}. Each answer shows what it used.`;
}
