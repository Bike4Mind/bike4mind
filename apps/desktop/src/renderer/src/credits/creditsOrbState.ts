import type { CreditsGlance } from './useCreditsGlance';
import type { CreditTone } from './creditOutlook';

export type CreditsOrbTone = CreditTone | 'unknown';

export type CreditsOrbState = {
  tone: CreditsOrbTone;
  /** How full the orb is, 0 to 1. The same runway scale as the menu's ring. */
  level: number;
  /** The balance being shown, or null when none has been read. */
  balance: number | null;
};

const TONE_PHRASE: Record<CreditsOrbTone, string> = {
  ok: 'ok',
  low: 'running low',
  critical: 'almost out',
  unknown: 'balance unavailable',
};

/**
 * What the rail orb shows. Tone and level come straight from the outlook, so the orb flips to
 * low and critical on exactly the thresholds the avatar dot used.
 */
export function creditsOrbState({ outlook, organization, profile }: CreditsGlance): CreditsOrbState {
  const balance = organization ? organization.credits : (profile?.credits.balance ?? null);
  if (outlook.kind === 'unknown') return { tone: 'unknown', level: 0, balance };
  return { tone: outlook.tone, level: outlook.ringFill, balance };
}

/** The orb's accessible name; always carries the state, since colour alone cannot. */
export function creditsOrbLabel(state: CreditsOrbState): string {
  const balance = state.balance === null ? '' : `, ${Math.round(state.balance).toLocaleString()} credits`;
  return `Credits: ${TONE_PHRASE[state.tone]}${state.tone === 'unknown' ? '' : balance}`;
}
