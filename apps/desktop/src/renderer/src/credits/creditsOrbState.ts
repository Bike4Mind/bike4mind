import type { CreditsGlance } from './useCreditsGlance';
import type { CreditTone } from './creditOutlook';
import { formatCredits } from './CreditsGlance';

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
  // The ring leaves `idle` (no burn to project from) empty because a number sits beside it; the
  // orb has none until clicked, so an idle balance that is positive reads as full, not out.
  // A level that is not a number (a bad burn read, say) must not read as out while credits remain.
  const hasBalance = balance !== null && balance > 0;
  const level = (outlook.kind === 'idle' || !Number.isFinite(outlook.ringFill)) && hasBalance ? 1 : outlook.ringFill;
  return { tone: outlook.tone, level: Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0, balance };
}

/** The lowest and highest liquid line, as a percent of the orb's height. */
export const ORB_FILL_FLOOR_PERCENT = 16;
export const ORB_FILL_CEILING_PERCENT = 78;

/**
 * How high the orb's liquid stands for a level. A full orb stops below the rim so its surface
 * stays visible (filled to the brim it is a flat disc that reads as empty), and any positive
 * level shows at least a sliver, so only a level of 0 is drawn empty.
 */
export function orbFillPercent(level: number): number {
  if (!Number.isFinite(level) || level <= 0) return 0;
  const span = ORB_FILL_CEILING_PERCENT - ORB_FILL_FLOOR_PERCENT;
  return Math.round(ORB_FILL_FLOOR_PERCENT + Math.min(1, level) * span);
}

/** The orb's accessible name; always carries the state, since colour alone cannot. */
export function creditsOrbLabel(state: CreditsOrbState): string {
  const balance = state.balance === null ? '' : `, ${formatCredits(state.balance)} credits`;
  return `Credits: ${TONE_PHRASE[state.tone]}${state.tone === 'unknown' ? '' : balance}`;
}
