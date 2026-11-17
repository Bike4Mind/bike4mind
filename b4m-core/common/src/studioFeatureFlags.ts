import { STUDIO_PRODUCTIONS_AUDIENCES, type SettingKey } from './schemas/settings';
import { isFreeTierExempt } from './schemas/user';

/**
 * Admin settings that gate the Studio rebuild. Who each one opens to is studioFeatureAudience. Read them
 * through the client hook (useStudioFeature) or the server helpers (server-utils middlewares/studioFeatureFlag)
 * (resolveStudioFeatureAccess) rather than the raw setting, so both sides apply the same rule.
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

export type StudioFeatureAudience = 'everyone' | 'paid' | 'admins';

/**
 * What a viewer gets for a Studio feature: 'open' (the feature), 'upgrade' (an upgrade prompt: a free viewer of a
 * paid feature) or 'closed' (not found).
 */
export type StudioFeatureAccess = 'open' | 'upgrade' | 'closed';

/**
 * The compiled-in audience of each feature, used when no audience setting applies. 'everyone': the settings
 * alone decide, so they act as a kill switch. 'paid': admins, developers and paid plans open it, free viewers get
 * an upgrade prompt. 'admins': an unfinished preview a non-admin never sees, whatever the settings say. A feature
 * open to everyone needs its parent open to everyone too (studioFeatureFlags.test.ts checks this).
 */
export const STUDIO_FEATURE_AUDIENCE: Record<StudioFeature, StudioFeatureAudience> = {
  createV2: 'everyone',
  // Image is the medium Create v2 adds and leads its rail with, so it opens with it.
  image: 'everyone',
  // Productions is a preview until an admin widens it through its audience setting.
  productions: 'admins',
};

/** Features whose audience an admin setting overrides at runtime, so launch is a settings change, not a deploy. */
export const STUDIO_FEATURE_AUDIENCE_SETTING: Partial<Record<StudioFeature, SettingKey>> = {
  productions: 'StudioProductionsAudience',
};

const SETTING_AUDIENCES: Partial<Record<StudioFeature, readonly string[]>> = {
  productions: STUDIO_PRODUCTIONS_AUDIENCES,
};

/** The audience in force: the setting's value when the feature has one and it is valid, else the compiled-in one (fails closed). */
export const studioFeatureAudience = (feature: StudioFeature, settingValue?: unknown): StudioFeatureAudience =>
  typeof settingValue === 'string' && SETTING_AUDIENCES[feature]?.includes(settingValue)
    ? (settingValue as StudioFeatureAudience)
    : STUDIO_FEATURE_AUDIENCE[feature];

/**
 * The one rule both sides apply (client useStudioFeatureAccess, server isStudioFeatureEnabled). `flagEnabled`: every
 * setting from studioFeatureSettingKeys is on. `hasPaidPlan`: the viewer holds PAID_PLAN_ENTITLEMENT_KEY; it only
 * matters for a 'paid' audience, so a caller may pass false until 'upgrade' comes back and then load it.
 */
export const resolveStudioFeatureAccess = ({
  viewer,
  hasPaidPlan,
  flagEnabled,
  audience,
}: {
  viewer: { isAdmin?: boolean | null; tags?: readonly string[] | null };
  hasPaidPlan: boolean;
  flagEnabled: boolean;
  audience: StudioFeatureAudience;
}): StudioFeatureAccess => {
  if (!flagEnabled) return 'closed';
  switch (audience) {
    case 'everyone':
      return 'open';
    case 'admins':
      return viewer.isAdmin === true ? 'open' : 'closed';
    case 'paid':
      return isFreeTierExempt(viewer) || hasPaidPlan ? 'open' : 'upgrade';
  }
};
