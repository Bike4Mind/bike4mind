import { useMemo } from 'react';
import { resolveLowCreditsThreshold, resolveTeamPlanSettings, type TeamPlanSettings } from '@bike4mind/common';
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
