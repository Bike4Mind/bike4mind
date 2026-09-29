import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import type { GearKey, GearKind } from '@client/lib/gears/keys';

/**
 * Gears - each gear's unlock and reward state (see pages/api/gears/status.ts and server/services/gears/catalog.ts).
 * Unlocks are derived server-side from data existence; this hook is the single
 * client source of truth for the Gears page and the sidenav's Gears tag.
 */

export type { GearKey, GearKind };

export interface GearStatus {
  key: GearKey;
  kind: GearKind;
  unlocked: boolean;
  credits: number;
  /** Conditions met, reward not taken yet - POST /api/gears/claim pays it. */
  claimable?: boolean;
  /** Paid - stays true even if the unlock later lapses (see the endpoint). */
  claimed?: boolean;
  rewardPending?: boolean;
  /** Presentation is server truth (code defaults + Manage Gears admin overrides). */
  title: string;
  tagline: string;
  intro: string;
  cta: string;
  ctaAction: string;
}

export interface GearsStatusResponse {
  gears: GearStatus[];
  totalUnlocked: number;
}

export function useGearsStatus() {
  return useQuery<GearsStatusResponse>({
    queryKey: ['gears', 'status'],
    queryFn: async () => (await api.get<GearsStatusResponse>('/api/gears/status')).data,
    // Unlocks only move forward and creations invalidate explicitly (or are
    // picked up on the next visit) - keep the nav from refetching on every mount.
    staleTime: 5 * 60_000,
  });
}

export interface ClaimGearResponse {
  key: GearKey;
  /** Set only on the response that actually paid - see pages/api/gears/claim.ts. */
  creditsAwarded?: number;
  alreadyClaimed?: boolean;
}

/**
 * Claim one gear's reward. The card flips at once and the status is then
 * refetched to confirm; the balance itself updates through the user
 * subscription, so nothing here touches it.
 */
export function useClaimGear() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (key: GearKey) => (await api.post<ClaimGearResponse>('/api/gears/claim', { key })).data,
    onSuccess: (_data, key) => {
      queryClient.setQueryData<GearsStatusResponse>(
        ['gears', 'status'],
        prev => prev && { ...prev, gears: prev.gears.map(g => (g.key === key ? { ...g, claimable: false } : g)) }
      );
      void queryClient.invalidateQueries({ queryKey: ['gears', 'status'] });
    },
  });
}

/**
 * Invalidate the gears/status query after a creation, but only while at least one
 * of the given destination gears is still locked in the cache. A creation unlocks
 * its gear server-side, yet the 5-minute staleTime would otherwise keep the new
 * reward (and the sidenav's Claim tag) hidden until a reload. Skipping the refetch once
 * the gear is already unlocked keeps routine creates from refetching every time.
 * No cached status means no observers to update, so there is nothing to invalidate.
 * Mirrors the inline pattern in SessionFilePond for the 'files' gear.
 */
export function invalidateGearsStatusWhileLocked(queryClient: QueryClient, keys: GearKey[]): void {
  const status = queryClient.getQueryData<GearsStatusResponse>(['gears', 'status']);
  if (!status) return;
  const anyStillLocked = keys.some(key => {
    const gear = status.gears.find(g => g.key === key);
    return gear && !gear.unlocked;
  });
  if (anyStillLocked) void queryClient.invalidateQueries({ queryKey: ['gears', 'status'] });
}
