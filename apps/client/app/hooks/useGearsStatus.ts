import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';

/**
 * Gears — the earned-nav progression state (see pages/api/gears/status.ts).
 * Unlocks are derived server-side from data existence; this hook is the single
 * client source of truth for both the Gears page and the sidenav's earned rows.
 */

export type GearKey = 'projects' | 'agents' | 'datalakes' | 'files' | 'published';

export interface GearStatus {
  key: GearKey;
  unlocked: boolean;
  creditsAwarded?: number;
}

export interface GearsStatusResponse {
  gears: GearStatus[];
  totalUnlocked: number;
  creditsPerUnlock: number;
}

export function useGearsStatus() {
  return useQuery<GearsStatusResponse>({
    queryKey: ['gears', 'status'],
    queryFn: async () => (await api.get<GearsStatusResponse>('/api/gears/status')).data,
    // Unlocks only move forward and creations invalidate explicitly (or are
    // picked up on the next visit) — keep the nav from refetching on every mount.
    staleTime: 5 * 60_000,
  });
}

/** Convenience map: key -> unlocked. `undefined` while loading (callers choose their fallback). */
export function useGearUnlocks(): Record<GearKey, boolean> | undefined {
  const { data } = useGearsStatus();
  if (!data) return undefined;
  return Object.fromEntries(data.gears.map(g => [g.key, g.unlocked])) as Record<GearKey, boolean>;
}
