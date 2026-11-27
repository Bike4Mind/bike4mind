import { useNavigate } from '@tanstack/react-router';
import { useAuthState } from '../auth/useAuthState';
import type { ClaudeImportKind } from '@shared/claudeImport';
import { SettingsScreen } from '../chat/SettingsPanel';
import type { SettingId, SettingsSection } from '../chat/settingsNavigation';

/** The settings route; it renders signed out too, since the server picker lives here. */
export function Settings({
  section,
  setting,
  importFocus,
}: {
  section: SettingsSection;
  setting?: SettingId;
  importFocus?: ClaudeImportKind;
}) {
  const state = useAuthState();
  const navigate = useNavigate();

  return (
    <SettingsScreen
      auth={state && state.status !== 'initializing' ? state : null}
      section={section}
      setting={setting}
      importFocus={importFocus}
      onSection={next => void navigate({ to: '/settings', search: { section: next }, replace: true })}
      onOpenSetting={link => void navigate({ to: '/settings', search: link, replace: true })}
      onClose={() => void navigate({ to: '/' })}
    />
  );
}
