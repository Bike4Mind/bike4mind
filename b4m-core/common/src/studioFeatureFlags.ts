import type { SettingKey } from './schemas/settings';

/**
 * Admin settings that gate the Studio rebuild. Who each one opens to is STUDIO_FEATURE_AUDIENCE. Read them
 * through the client hook (useStudioFeature) or the server helpers (server-utils middlewares/studioFeatureFlag)
 * rather than the raw setting, so both sides apply the same rule.
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

/**
 * Who a Studio feature opens to once its settings are on. 'everyone': the settings alone decide, so they act as
 * a kill switch. 'admins': an unfinished preview a non-admin never sees, whatever the settings say. A feature
 * open to everyone needs its parent open to everyone too (studioFeatureFlags.test.ts checks this).
 */
export const STUDIO_FEATURE_AUDIENCE: Record<StudioFeature, 'everyone' | 'admins'> = {
  createV2: 'everyone',
  // Image is the medium Create v2 adds and leads its rail with, so it opens with it.
  image: 'everyone',
  // Productions is still a coming-soon placeholder.
  productions: 'admins',
};

/** Whether `feature` can open to this viewer at all, before any setting is read. */
export const isStudioFeatureVisibleTo = (feature: StudioFeature, isAdmin: boolean): boolean =>
  isAdmin || STUDIO_FEATURE_AUDIENCE[feature] === 'everyone';

/** The one rule both sides apply: every setting from studioFeatureSettingKeys on, and the feature visible to the viewer. */
export const isStudioFeatureOpen = ({
  feature,
  isAdmin,
  flagEnabled,
}: {
  feature: StudioFeature;
  isAdmin: boolean;
  flagEnabled: boolean;
}): boolean => flagEnabled && isStudioFeatureVisibleTo(feature, isAdmin);
