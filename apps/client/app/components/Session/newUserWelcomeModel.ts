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

interface CreditsLineArgs {
  enforceCredits: boolean;
  balance: number;
  /** Signed up openly and still owes email verification before the starter grant lands. */
  awaitingVerification: boolean;
  /** What verification will grant: the user's invite amount, else the defaultFreeCredits setting. */
  pendingGrant: number | null;
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
}: CreditsLineArgs): string | null {
  if (!enforceCredits) return null;
  if (awaitingVerification) {
    return pendingGrant && pendingGrant > 0
      ? `Verify your email to unlock your ${formatCreditBalance(pendingGrant)}.`
      : 'Verify your email to unlock your free credits.';
  }
  if (balance <= 0) return null;
  return `You're starting with ${formatCreditBalance(balance)}. Each answer shows what it used, and your balance sits next to the send button.`;
}
