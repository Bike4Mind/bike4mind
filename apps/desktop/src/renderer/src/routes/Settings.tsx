import { useNavigate } from '@tanstack/react-router';
import { useAuthState } from '../auth/useAuthState';
import { SettingsScreen, type SettingsSection } from '../chat/SettingsPanel';

/** The settings route; it renders signed out too, since the server picker lives here. */
export function Settings({ section }: { section: SettingsSection }) {
  const state = useAuthState();
  const navigate = useNavigate();

  return (
    <SettingsScreen
      auth={state && state.status !== 'initializing' ? state : null}
      section={section}
      onSection={next => void navigate({ to: '/settings', search: { section: next }, replace: true })}
      onClose={() => void navigate({ to: '/' })}
    />
  );
}
