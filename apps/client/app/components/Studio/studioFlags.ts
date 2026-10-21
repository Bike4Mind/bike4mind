import type { SettingKey } from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import { useAdminSettingsCache } from '@client/app/hooks/useAdminSettingsCache';

/** Gates for the Studio rebuild. Every flag is off unless the matching admin setting is on AND the viewer is an admin. */
export type StudioFlags = {
  /** The restructured Studio: Create / Productions / Library with a medium rail. */
  createV2: boolean;
  /** The Image medium and its `image` generation job kind. */
  image: boolean;
  /** Productions: the composition entity, timeline and render. */
  productions: boolean;
};

/** Must stay in sync with the EnableStudio* entries in b4m-core/common/src/schemas/settings.ts. */
export const STUDIO_FLAG_SETTING_KEYS = {
  createV2: 'EnableStudioCreateV2',
  image: 'EnableStudioImage',
  productions: 'EnableStudioProductions',
} as const satisfies Record<keyof StudioFlags, SettingKey>;

export const STUDIO_FLAGS_OFF: StudioFlags = { createV2: false, image: false, productions: false };

/**
 * Pure resolution of the Studio gates. Admin-only until the reveal: dropping the `isAdmin` term
 * here is the one change that opens the rebuild to everyone the settings allow. Image and
 * Productions live inside Create v2, so they require it (settings `dependsOn` is only a console hint).
 */
export const resolveStudioFlags = ({
  isAdmin,
  isSettingOn,
}: {
  isAdmin: boolean;
  isSettingOn: (key: SettingKey) => boolean;
}): StudioFlags => {
  if (!isAdmin) return STUDIO_FLAGS_OFF;
  const createV2 = isSettingOn(STUDIO_FLAG_SETTING_KEYS.createV2);
  return {
    createV2,
    image: createV2 && isSettingOn(STUDIO_FLAG_SETTING_KEYS.image),
    productions: createV2 && isSettingOn(STUDIO_FLAG_SETTING_KEYS.productions),
  };
};

/** Reads the Studio gates for the current viewer. Fails closed (all off) while settings are loading. */
export const useStudioFlags = (): StudioFlags => {
  const isAdmin = useUser(state => state.isAdmin ?? false);
  const { isFeatureEnabled } = useAdminSettingsCache();
  return resolveStudioFlags({ isAdmin, isSettingOn: isFeatureEnabled });
};
