import { useMemo } from 'react';
import {
  resolveLowCreditsThreshold,
  resolveTeamPlanSettings,
  settingsMap,
  type TeamPlanSettings,
} from '@bike4mind/common';
import { useGetSettingsValue } from './settings';

/**
 * The admin-configured team seat floor/ceiling (Admin -> Growth & Pricing), resolved the same way
 * the server resolves them (`getTeamPlanSettings`), so a seat picker never offers a count the API
 * would reject. Falls back to the ORGANIZATION_SUBSCRIPTION_* constants until settings load.
 */
export function useTeamSeatLimits(): Pick<TeamPlanSettings, 'minSeats' | 'maxSeats'> {
  const teamPlanMinSeats = useGetSettingsValue('teamPlanMinSeats');
  const teamPlanMaxSeats = useGetSettingsValue('teamPlanMaxSeats');
  return useMemo(() => {
    const { minSeats, maxSeats } = resolveTeamPlanSettings({ teamPlanMinSeats, teamPlanMaxSeats });
    return { minSeats, maxSeats };
  }, [teamPlanMinSeats, teamPlanMaxSeats]);
}

/**
 * Whether NEW Team purchases are open (`enableTeamPlan`). The single client-side gate for every Team
 * checkout entry point; the server enforces the same flag in pages/api/organizations/subscriptions/subscribe.ts.
 * Parsed through the setting's own schema (which coerces the string 'true') so client and server agree;
 * an unloaded or malformed value fails closed. On a malformed value the server falls back to the
 * setting's `defaultValue`, so the two agree only while that default stays `false`.
 */
export function useTeamPlanAvailable(): boolean {
  const raw = useGetSettingsValue('enableTeamPlan');
  return useMemo(() => {
    const parsed = settingsMap.enableTeamPlan.schema.safeParse(raw);
    return parsed.success && parsed.data === true;
  }, [raw]);
}

/** Team-plan credits granted per seat. Admin-only: the setting is not readable by other users. */
export function useTeamCreditsPerSeat(): number {
  const raw = useGetSettingsValue('teamPlanCreditsPerSeat');
  return useMemo(() => resolveTeamPlanSettings({ teamPlanCreditsPerSeat: raw }).creditsPerSeat, [raw]);
}

/** The credit balance below which the UI shows its low-credit warning state (`lowCreditsThreshold`). */
export function useLowCreditsThreshold(): number {
  const raw = useGetSettingsValue('lowCreditsThreshold');
  return useMemo(() => resolveLowCreditsThreshold(raw), [raw]);
}
