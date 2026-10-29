import { CssVarsProvider } from '@mui/joy/styles';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AuthState } from '@shared/auth';
import { isSettingsSection, SETTINGS_SECTIONS, SettingsScreen, type SettingsSection } from './SettingsPanel';

/** Rendered to a string, like CustomizePanel's tests and for the same reason: vitest runs on `node`. */
const markup = (node: React.ReactNode) => renderToStaticMarkup(<CssVarsProvider>{node}</CssVarsProvider>);

const signedIn: AuthState = {
  status: 'signed-in',
  environment: { preset: 'hosted', label: 'Production', url: 'https://example.invalid' },
  hostedAvailable: true,
  storage: 'available',
  busy: 'idle',
};

describe('the Settings screen', () => {
  const html = markup(<SettingsScreen auth={signedIn} onClose={() => {}} />);
  const page = (section: SettingsSection) =>
    markup(<SettingsScreen auth={signedIn} section={section} onClose={() => {}} />);

  it('opens on General, which holds app preferences, connection, and maintenance', () => {
    expect(html).toContain('data-testid="settings-page-general"');
    expect(html).toContain('data-entry="appearance"');
    expect(html).toContain('data-entry="prompt-suggestions"');
    expect(html).toContain('data-entry="server"');
    expect(html).toContain('data-entry="updates"');
    expect(html).toContain('data-entry="worktree-default"');
    expect(html).toContain('data-entry="local-history"');
    expect(html).toContain('data-entry="local-context"');
    expect(html).toContain('settings-local-context-select');
    expect(html).toContain('settings-clear-history-btn');
    expect(html).not.toContain('data-entry="permissions"');
    expect(html).not.toContain('data-entry="claude-import"');
  });

  it('lists every page in the side nav, whichever one is open', () => {
    for (const section of SETTINGS_SECTIONS) {
      const html = page(section);
      for (const id of SETTINGS_SECTIONS) expect(html).toContain(`data-testid="settings-nav-${id}-btn"`);
    }
  });

  it('gives Permissions and Import a page each', () => {
    const permissions = page('permissions');
    expect(permissions).toContain('data-entry="permissions"');
    expect(permissions).not.toContain('data-entry="appearance"');
    const imports = page('import');
    expect(imports).toContain('data-entry="claude-import"');
    expect(imports).not.toContain('data-entry="appearance"');
  });

  it('gives model servers their own page, which works signed out too', () => {
    const servers = markup(<SettingsScreen auth={null} section="servers" onClose={() => {}} />);
    expect(servers).toContain('data-entry="model-servers"');
    expect(servers).toContain('data-testid="model-servers"');
    expect(servers).not.toContain('data-entry="appearance"');
    expect(isSettingsSection('servers')).toBe(true);
  });

  it('only takes known page names from the route', () => {
    expect(isSettingsSection('worktrees')).toBe(true);
    expect(isSettingsSection('import')).toBe(true);
    expect(isSettingsSection('billing')).toBe(false);
    expect(isSettingsSection(undefined)).toBe(false);
  });

  it('offers appearance as a three-way choice', () => {
    for (const mode of ['system', 'light', 'dark']) {
      expect(html).toContain(`settings-appearance-${mode}-btn`);
    }
  });

  it('offers the suggested next prompt preference', () => {
    expect(html).toContain('data-testid="settings-suggestions-switch"');
  });

  it('offers the worktree-by-default preference', () => {
    expect(html).toContain('data-testid="settings-worktree-default-switch"');
  });

  it('mounts the same server picker and updater, not copies of them', () => {
    expect(html).toContain('data-testid="environment-select-btn"');
    expect(html).toContain('data-testid="update-settings"');
  });

  /** The caption came with the picker: it is the one thing the picker cannot say about itself. */
  it('keeps the line saying how far the server choice reaches', () => {
    expect(html).toContain('Hosted conversations use this server. Local models run on this device.');
  });

  it('says what the General page owns', () => {
    expect(html).toContain('How the app looks, behaves, connects, and keeps itself up to date.');
  });

  it('keeps a way out of the screen', () => {
    expect(html).toContain('data-testid="settings-close-btn"');
  });

  /**
   * A renderer that has not talked to main yet knows of no server, and the screen is still the
   * only place to set one - so the updater has to render without an auth state behind it.
   */
  it('still renders before auth has reported', () => {
    const early = markup(<SettingsScreen auth={null} onClose={() => {}} />);
    expect(early).toContain('data-entry="appearance"');
    expect(early).toContain('data-entry="prompt-suggestions"');
    expect(early).toContain('data-entry="updates"');
    expect(early).not.toContain('data-entry="server"');
  });
});
