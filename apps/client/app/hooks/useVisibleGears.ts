import { useState } from 'react';
import { useGearsStatus, type GearKey } from '@client/app/hooks/useGearsStatus';
import { isGettingStarted } from '@client/lib/gears/tabs';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import { useAdminSettingsCache } from '@client/app/hooks/useAdminSettingsCache';
import { useUser } from '@client/app/contexts/UserContext';
import { isBrandNewAccount } from '@client/app/utils/onboarding';

/**
 * The gears this deployment offers. A gear whose feature is switched off is
 * dropped, since it would dead-end on gated endpoints - and the sidenav marker
 * reads from here too, so it never points at a card the page will not show.
 */
export function useVisibleGears() {
  const query = useGearsStatus();
  const { isFeatureEnabled } = useFeatureEnabled();
  const { isFeatureEnabled: isAdminFeatureEnabled } = useAdminSettingsCache();

  const visible = (key: GearKey) => {
    if (key === 'agents') return isFeatureEnabled('enableAgents');
    if (key === 'datalakes') return isAdminFeatureEnabled('EnableDataLakes');
    if (key === 'hearth') return isFeatureEnabled('enableHearth');
    return true;
  };

  return { ...query, gears: (query.data?.gears ?? []).filter(g => visible(g.key)) };
}

/** How long an account counts as new for the sidenav's Start here tag. */
export const START_HERE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * What the sidenav's Gears row should flag.
 *
 * - `startHere`: the account is under 30 days old and a Getting Started gear is
 *   still undone. Unlocked or already paid both count as done, so deleting your
 *   only project does not bring the tag back. The age cap is what keeps it from
 *   becoming permanent for someone who never publishes an artifact, and from
 *   appearing at once for every existing user when it ships.
 * - `claimableCount`: how many rewards are waiting to be taken.
 *
 * Both are empty while the status loads, so neither flickers in and out.
 */
export function useGearsNavSignal(): { startHere: boolean; claimableCount: number } {
  const { gears } = useVisibleGears();
  const createdAt = useUser(s => s.currentUser?.createdAt);
  // Read once per mount: render must stay pure, and a 30-day window has no
  // need to tick while the app is open.
  const [now] = useState(() => Date.now());
  return {
    startHere:
      isBrandNewAccount(createdAt, now, START_HERE_WINDOW_MS) &&
      gears.some(g => isGettingStarted(g) && !g.unlocked && !g.claimed),
    claimableCount: gears.filter(g => g.claimable).length,
  };
}

export type GearsMenuDot = 'claim' | 'start' | null;

/**
 * The dot on the phone header's menu button, which stands in for the Gears
 * row's tag while the sidenav is closed behind it. Same precedence as the tag: a
 * reward to claim wins over Start here.
 */
export const gearsMenuDot = ({ startHere, claimableCount }: ReturnType<typeof useGearsNavSignal>): GearsMenuDot =>
  claimableCount > 0 ? 'claim' : startHere ? 'start' : null;
