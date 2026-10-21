import type { SettingKey } from './schemas/settings';

/**
 * Admin settings that gate the Studio rebuild. Each one is admin-only until the reveal: a non-admin is
 * never let in, whatever the setting says. Read them through the client hook (useStudioFeature) or the
 * server helpers (server-utils middlewares/studioFeatureFlag) rather than the raw setting, so both sides
 * apply the same admin rule.
 */
export const STUDIO_FEATURE_FLAGS = {
  createV2: 'EnableStudioCreateV2',
  image: 'EnableStudioImage',
  productions: 'EnableStudioProductions',
} as const satisfies Record<string, SettingKey>;

export type StudioFeature = keyof typeof STUDIO_FEATURE_FLAGS;

/** The one rule both sides apply: the flag must be on and the viewer must be an admin. */
export const isStudioFeatureOpen = ({ isAdmin, flagEnabled }: { isAdmin: boolean; flagEnabled: boolean }): boolean =>
  isAdmin && flagEnabled;
