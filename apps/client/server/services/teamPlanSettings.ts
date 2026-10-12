import { adminSettingsRepository } from '@bike4mind/database';
import { BadRequestError, loadTeamPlanSettings } from '@bike4mind/utils';
import type { TeamPlanSettings } from '@bike4mind/common';

/**
 * The admin-configured team-plan seat floor/ceiling and credits per seat (Admin -> Growth & Pricing),
 * falling back to the ORGANIZATION_SUBSCRIPTION_* constants. Every app-side seat check and team
 * credit grant reads this; the client reads the same settings through the hooks in app/hooks/data/teamPlanSettings.
 */
export function getTeamPlanSettings(): Promise<TeamPlanSettings> {
  return loadTeamPlanSettings({ adminSettings: adminSettingsRepository });
}

/** Throws a 400 unless `seats` is within the paid-plan floor and ceiling. */
export function assertSeatsWithinPlan(
  seats: number,
  { minSeats, maxSeats }: Pick<TeamPlanSettings, 'minSeats' | 'maxSeats'>
) {
  if (seats < minSeats || seats > maxSeats) {
    throw new BadRequestError(`Seats must be between ${minSeats} and ${maxSeats}`);
  }
}
