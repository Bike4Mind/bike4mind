/**
 * Gears discovery modal - which unused gears to suggest and when. Pure apart from
 * the storage helpers; the hook is app/hooks/useGearsDiscovery.ts.
 */

import type { GearKey } from '@client/lib/gears/keys';

const DAY_MS = 24 * 60 * 60 * 1000;

export const DISCOVERY_COOLDOWN_MS = DAY_MS;
export const DISCOVERY_MIN_CANDIDATES = 1;
export const DISCOVERY_MAX_CARDS = 3;
export const DISCOVERY_SETTLE_MS = 5000;
export const DISCOVERY_RECHECK_MS = 10_000;

/** Most valuable first. Keys not listed still appear, after these. */
export const DISCOVERY_PRIORITY: readonly GearKey[] = [
  'models',
  'agents',
  'projects',
  'datalakes',
  'files',
  'research',
  'websearch',
  'published',
  'shareproject',
  'image',
  'voice',
  'video',
  'music',
  'sound',
  'react',
  'python',
  'mementos',
  'questmaster',
  'rapidreply',
  'mcp',
  'slack',
  'importopenai',
  'importclaude',
  'apikey',
  'apicall',
  'shareagent',
  'forknotebook',
  'downloadnotebook',
  'webfetch',
  'wolfram',
  'matheval',
  'mfa',
  'hearth',
  'clidocs',
];

/**
 * Routes the modal never opens over: pages that own their first screen, and the gears page itself.
 * Leaving one of them keeps the decision open, so the modal can still show on the next page.
 */
export const DISCOVERY_SKIPPED_PATHS: readonly string[] = ['/admin', '/gears', '/bob'];

export function isDiscoverySkippedPath(pathname: string): boolean {
  // The router matches paths case-insensitively, so /Bob renders the Bob screen too.
  const path = pathname.toLowerCase();
  return DISCOVERY_SKIPPED_PATHS.some(p => path === p || path.startsWith(`${p}/`));
}

/** Same window as the b4m_utm session cookie (utmCapture.ts): long enough to cover sign-up. */
export const DISCOVERY_CAMPAIGN_HOLD_MS = 30 * 60 * 1000;

const CAMPAIGN_HOLD_KEY = 'gears_discovery_campaign_landing';
let campaignLandedAt: number | undefined;

/**
 * Holds the modal after a campaign landing. Called at bootstrap in app/router.tsx when
 * captureUtmParams() saw one. Kept in sessionStorage, not the consent-gated UTM cookie, so it
 * survives the full reload of an OAuth sign-up in the same tab whatever the visitor's consent.
 */
export function holdDiscoveryForCampaign(now: number): void {
  campaignLandedAt = now;
  try {
    sessionStorage.setItem(CAMPAIGN_HOLD_KEY, String(now));
  } catch {
    // Private mode or quota: the hold still covers this page load.
  }
}

export function isDiscoveryHeldForCampaign(now: number): boolean {
  let landedAt = campaignLandedAt;
  try {
    const stored = Number(sessionStorage.getItem(CAMPAIGN_HOLD_KEY));
    if (stored > 0) landedAt = Math.max(landedAt ?? 0, stored);
  } catch {
    // Fall back to this page load's hold.
  }
  return landedAt !== undefined && landedAt <= now && now - landedAt < DISCOVERY_CAMPAIGN_HOLD_MS;
}

export function resetCampaignHoldForTests(): void {
  campaignLandedAt = undefined;
  try {
    sessionStorage.removeItem(CAMPAIGN_HOLD_KEY);
  } catch {
    // Nothing to clear.
  }
}

export interface DiscoveryState {
  lastShownAt: number;
  dismissed: boolean;
  rotation: number;
}

export const EMPTY_DISCOVERY_STATE: DiscoveryState = { lastShownAt: 0, dismissed: false, rotation: 0 };

interface DiscoverableGear {
  key: string;
  unlocked: boolean;
  claimed?: boolean;
}

export function discoveryCandidates<T extends DiscoverableGear>(gears: readonly T[]): T[] {
  const rank = (key: string) => {
    const i = (DISCOVERY_PRIORITY as readonly string[]).indexOf(key);
    return i === -1 ? DISCOVERY_PRIORITY.length : i;
  };
  // Array sort is stable, so unlisted keys keep the endpoint's order.
  return gears.filter(g => !g.unlocked && !g.claimed).sort((a, b) => rank(a.key) - rank(b.key));
}

export function pickDiscoveryGears<T>(candidates: readonly T[], rotation: number): T[] {
  if (candidates.length <= DISCOVERY_MAX_CARDS) return [...candidates];
  const start = rotation % candidates.length;
  return Array.from({ length: DISCOVERY_MAX_CARDS }, (_, i) => candidates[(start + i) % candidates.length]);
}

export function shouldShowDiscovery({
  state,
  candidateCount,
  now,
}: {
  state: DiscoveryState;
  candidateCount: number;
  now: number;
}): boolean {
  if (state.dismissed || candidateCount < DISCOVERY_MIN_CANDIDATES) return false;
  // A future timestamp means the clock moved back; honouring it could hide the modal for months.
  return !(state.lastShownAt <= now && now - state.lastShownAt < DISCOVERY_COOLDOWN_MS);
}

const storageKey = (userId: string) => `gears_discovery_${userId}`;

export function readDiscoveryState(userId: string): DiscoveryState {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    if (!raw) return EMPTY_DISCOVERY_STATE;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return EMPTY_DISCOVERY_STATE;
    const o = parsed as Record<string, unknown>;
    return {
      lastShownAt: typeof o.lastShownAt === 'number' && Number.isFinite(o.lastShownAt) ? o.lastShownAt : 0,
      dismissed: o.dismissed === true,
      rotation: typeof o.rotation === 'number' && Number.isInteger(o.rotation) && o.rotation >= 0 ? o.rotation : 0,
    };
  } catch {
    return EMPTY_DISCOVERY_STATE;
  }
}

export function writeDiscoveryState(userId: string, state: DiscoveryState): void {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(state));
  } catch {
    // Private mode or quota: the worst case is the modal returning sooner.
  }
}
