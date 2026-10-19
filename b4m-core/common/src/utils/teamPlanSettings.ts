import { settingsMap } from '../schemas/settings';

/**
 * The admin-tunable team-plan knobs, resolved. Every enforcement site (checkout, seat changes,
 * admin grants, the partner-signup auto-raise in OrganizationModel, the invoice credit grant, and
 * the owner-facing seat pickers) derives its numbers from this one resolver so the UI, the API and
 * the persistence layer can never disagree about the floor or ceiling.
 */
export interface TeamPlanSettings {
  minSeats: number;
  maxSeats: number;
  creditsPerSeat: number;
}

export const TEAM_PLAN_SETTING_KEYS = ['teamPlanMinSeats', 'teamPlanMaxSeats', 'teamPlanCreditsPerSeat'] as const;
export type TeamPlanSettingKey = (typeof TEAM_PLAN_SETTING_KEYS)[number];

function parseOrDefault(key: TeamPlanSettingKey | 'lowCreditsThreshold', raw: unknown): number {
  const setting = settingsMap[key];
  const parsed = setting.schema.safeParse(raw);
  // An out-of-range or garbled stored value must not take the plan down: use the declared default.
  // All four settings declare a default; `?? 0` only satisfies the factory's optional type.
  return parsed.success ? parsed.data : (setting.defaultValue ?? 0);
}

/**
 * Raw stored values (absent, string or number) -> validated team-plan settings. A floor above the
 * ceiling is an inconsistent pair the per-setting schemas cannot catch on their own, so the
 * ceiling wins: the floor is clamped down to it rather than making every seat count invalid.
 */
export function resolveTeamPlanSettings(raw: Partial<Record<TeamPlanSettingKey, unknown>>): TeamPlanSettings {
  const maxSeats = parseOrDefault('teamPlanMaxSeats', raw.teamPlanMaxSeats);
  const minSeats = Math.min(parseOrDefault('teamPlanMinSeats', raw.teamPlanMinSeats), maxSeats);
  const creditsPerSeat = parseOrDefault('teamPlanCreditsPerSeat', raw.teamPlanCreditsPerSeat);
  return { minSeats, maxSeats, creditsPerSeat };
}

/** Raw stored `lowCreditsThreshold` -> the balance below which the UI warns. */
export function resolveLowCreditsThreshold(raw: unknown): number {
  return parseOrDefault('lowCreditsThreshold', raw);
}
