import { useServerSettings } from '@client/app/contexts/UserSettingsContext';

/** The admin setting that switches core's own tutorials on. */
export const CORE_TUTORIALS_SETTING = 'EnableCoreTutorials';

export interface TutorialsEnabledOptions {
  /** Whether this user may see the host's tutorials at all. A premium host passes its own access check. */
  hasAccess?: boolean;
  /** Every one of these admin settings must be on. Defaults to core's own switch. */
  settings?: readonly string[];
}

/** The guided tutorials show for a user with access, once an admin has switched on every setting they depend on. */
export function useTutorialsEnabled({
  hasAccess = true,
  settings = [CORE_TUTORIALS_SETTING],
}: TutorialsEnabledOptions = {}): boolean {
  const { serverSettings } = useServerSettings();
  const isOn = (name: string) =>
    String(serverSettings?.find(setting => setting.settingName === name)?.settingValue).toLowerCase() === 'true';
  return hasAccess && settings.every(isOn);
}
