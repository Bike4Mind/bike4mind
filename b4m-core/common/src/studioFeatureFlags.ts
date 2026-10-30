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

/**
 * Image and Productions live inside the Create v2 layout (its medium rail and section switcher), so each
 * opens only with Create v2 on. Settings `dependsOn` mirrors this, but only as an admin-console hint, so
 * this map is what both sides enforce; settings.ts must stay in sync with it.
 */
export const STUDIO_FEATURE_PARENT: Partial<Record<StudioFeature, StudioFeature>> = {
  image: 'createV2',
  productions: 'createV2',
};

/** Every admin setting that must be on for `feature` to open: its ancestors' settings, then its own. */
export const studioFeatureSettingKeys = (feature: StudioFeature): SettingKey[] => {
  const parent = STUDIO_FEATURE_PARENT[feature];
  return [...(parent ? studioFeatureSettingKeys(parent) : []), STUDIO_FEATURE_FLAGS[feature]];
};

/** The one rule both sides apply: the viewer must be an admin and every setting from studioFeatureSettingKeys on. */
export const isStudioFeatureOpen = ({ isAdmin, flagEnabled }: { isAdmin: boolean; flagEnabled: boolean }): boolean =>
  isAdmin && flagEnabled;
