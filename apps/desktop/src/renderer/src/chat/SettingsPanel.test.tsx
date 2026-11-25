import { CssVarsProvider } from '@mui/joy/styles';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '@shared/auth';
import { initialUpdateState, reduceUpdate, type UpdateState } from '@shared/update';
import { REPLY_STATS } from './replyStats';
import { SettingsScreen } from './SettingsPanel';
import { PAGE_ENTRIES, SETTINGS_SECTIONS, type SettingsSection } from './settingsNavigation';
import { currentThemeMode, nextThemeMode, themeModeSummary } from './themeMode';
import type { AppUpdateController } from './useAppUpdate';

const update = vi.hoisted(() => ({ state: null as UpdateState | null }));

vi.mock('./useAppUpdate', () => ({
  useAppUpdate: (): AppUpdateController => ({
    state: update.state ?? initialUpdateState('', false),
    blockedBy: null,
    downloadFailed: false,
    check: () => {},
    download: () => {},
    install: async () => false,
    dismissBlock: () => {},
    dismiss: () => {},
  }),
}));

beforeEach(() => {
  update.state = initialUpdateState('1.2.3', true);
});

/** Rendered to a string, like CustomizePanel's tests and for the same reason: vitest runs on `node`. */
const markup = (node: React.ReactNode) => renderToStaticMarkup(<CssVarsProvider>{node}</CssVarsProvider>);

const signedIn: AuthState = {
  status: 'signed-in',
  environment: { preset: 'hosted', label: 'Production', url: 'https://example.invalid' },
  hostedAvailable: true,
  storage: 'available',
  busy: 'idle',
  user: { id: 'u1' },
};

const page = (section: SettingsSection, auth: AuthState | null = signedIn) =>
  markup(<SettingsScreen auth={auth} section={section} onClose={() => {}} />);

/** The page body only: the nav lists every page's name, which would match anything. */
const pageBody = (html: string) => html.slice(html.indexOf('data-testid="settings-page-'));

const entriesOn = (html: string) => [...pageBody(html).matchAll(/data-entry="([^"]+)"/g)].map(match => match[1]);

describe('the Settings screen', () => {
  const html = markup(<SettingsScreen auth={signedIn} onClose={() => {}} />);

  it('opens on General', () => {
    expect(html).toContain('data-testid="settings-page-general"');
    expect(html).toContain('How the app looks and how the sidebar behaves.');
  });

  /** The guard for PAGE_ENTRIES: an entry the hook builds but no page lists would show up here. */
  it.each(SETTINGS_SECTIONS)('shows exactly the %s entries PAGE_ENTRIES places there, in order', section => {
    const expected: readonly string[] = PAGE_ENTRIES[section];
    expect(entriesOn(page(section))).toEqual(expected);
  });

  it('places every entry on exactly one page', () => {
    const all = SETTINGS_SECTIONS.flatMap(section => entriesOn(page(section)));
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(SETTINGS_SECTIONS.flatMap(section => PAGE_ENTRIES[section]).length);
  });

  it('lists every page in the side nav, whichever one is open, with About pinned last', () => {
    for (const section of SETTINGS_SECTIONS) {
      const html = page(section);
      for (const id of SETTINGS_SECTIONS) expect(html).toContain(`data-testid="settings-nav-${id}-btn"`);
      expect(html.indexOf('settings-nav-about-btn')).toBeGreaterThan(html.indexOf('settings-nav-advanced-btn'));
    }
  });

  it('shows the version under About and marks it when an update is waiting', () => {
    const current = page('general');
    expect(current).toContain('Version 1.2.3');
    expect(current).not.toContain('data-testid="settings-nav-about-attention"');
    update.state = reduceUpdate(initialUpdateState('1.2.3', true), { type: 'available', version: '1.3.0', at: 1 });
    const offered = page('general');
    const chip = offered.indexOf('data-testid="settings-nav-about-attention"');
    expect(chip).toBeGreaterThan(-1);
    expect(offered.slice(chip, chip + 2000)).toContain('>Update<');
    expect(offered).not.toContain('data-testid="settings-nav-general-attention"');
  });

  it('says when the update server could not be reached, and offers release notes when known', () => {
    update.state = reduceUpdate(initialUpdateState('1.2.3', true), { type: 'unreachable' });
    const unreachable = page('about');
    expect(unreachable).toContain('reach the update server.');
    expect(unreachable).toMatch(/data-testid="update-check-btn"[^>]*>Try again</);
    expect(unreachable).not.toContain('update-release-notes-btn');
    update.state = {
      ...reduceUpdate(initialUpdateState('1.2.3', true), { type: 'available', version: '1.3.0', at: 1 }),
      releaseUrl: 'https://example.invalid/releases/1.3.0',
    };
    expect(page('about')).toContain('data-testid="update-release-notes-btn"');
  });

  it('gives the single-setting pages a heading and the control without a row around it', () => {
    const permissions = page('permissions');
    expect(permissions).toContain('>Permissions</h2>');
    expect(permissions).toContain('data-entry="permissions"');
    const about = page('about');
    expect(about).toContain('Your version, updates, and what changed.');
    expect(about).toContain('data-testid="update-settings"');
    expect(about).not.toContain('aria-labelledby="settings-label-updates"');
  });

  it('highlights the row a deep link names', () => {
    const linked = markup(
      <SettingsScreen auth={signedIn} section="models" setting="model-servers" onClose={() => {}} />
    );
    expect(linked).toMatch(/data-entry="model-servers" data-highlighted="true"/);
    expect(linked).not.toMatch(/data-entry="reply-stats" data-highlighted/);
    expect(page('models')).not.toContain('data-highlighted');
  });

  it('works signed out, minus the server picker', () => {
    const models = page('models', null);
    expect(models).toContain('data-entry="model-servers"');
    expect(models).toContain('data-testid="model-servers"');
    expect(entriesOn(page('advanced', null))).not.toContain('server');
  });

  it('offers the notify scope, agents only by default', () => {
    const notifications = page('notifications');
    expect(notifications).toContain('data-testid="settings-notify-scope-agents-btn"');
    expect(notifications).toContain('data-testid="settings-notify-scope-all-btn"');
    expect(notifications).toContain('data-testid="settings-orchestrator-sound-switch"');
  });

  it('keeps helper agent model settings behind an expandable disclosure', () => {
    const agents = page('agents');
    expect(agents).toContain('data-testid="settings-worker-models-details"');
    expect(agents).toContain('data-testid="orchestration-settings"');
    expect(agents).toContain('data-testid="settings-worktree-default-switch"');
    expect(agents).toContain('data-testid="settings-autofix-attempts-select"');
  });

  it('offers appearance as a three-way choice, and the suggestion switch', () => {
    for (const mode of ['system', 'light', 'dark']) expect(html).toContain(`settings-appearance-${mode}-btn`);
    expect(html).toContain('data-testid="settings-suggestions-switch"');
  });

  it('keeps the reply stats detail in the control, under a one-line description', () => {
    const models = page('models');
    expect(models).toContain('Show speed and token counts beside each reply.');
    expect(models).toContain('data-testid="settings-reply-stats-rail-switch"');
    for (const id of REPLY_STATS) expect(models).toContain(`data-testid="settings-reply-stat-${id}-checkbox"`);
    expect(models).toContain('Draft acceptance is reported by llama-server');
    expect(models).toContain('settings-local-context-select');
    expect(models).toContain('settings-curated-source-switch');
  });

  it('keeps local data, export and the Claude import together', () => {
    const privacy = page('privacy');
    expect(privacy).toContain('settings-clear-history-btn');
    expect(privacy).toContain('settings-export-local-btn');
  });

  it('says how far the server choice reaches', () => {
    const advanced = page('advanced');
    expect(advanced).toContain('data-testid="environment-select-btn"');
    expect(advanced).toContain('Hosted conversations use this server. Local models are not affected.');
  });

  it('gives every row a description', () => {
    for (const section of SETTINGS_SECTIONS) {
      const rows = pageBody(page(section)).split('aria-labelledby="settings-label-').slice(1);
      for (const row of rows) expect(row).toMatch(/data-testid="config-entry-summary"[^>]*>[^<]+\./);
    }
  });

  it('starts with an empty search box and no results', () => {
    expect(html).toContain('data-testid="settings-search-input"');
    expect(html).toContain('placeholder="Search settings"');
    expect(html).not.toContain('settings-search-results');
  });

  it.each([null, { ...signedIn, status: 'signed-out' as const }, { ...signedIn, user: undefined }])(
    'keeps Settings independent of account billing',
    auth => {
      const html = markup(<SettingsScreen auth={auth} onClose={() => {}} />);
      expect(html).not.toContain('data-testid="settings-nav-billing-btn"');
      expect(html).not.toContain('billing-loading');
      expect(html).toContain('data-testid="settings-page-general"');
    }
  );

  it('keeps a way out of the screen', () => {
    expect(html).toContain('data-testid="settings-close-btn"');
  });
});

describe('themeMode', () => {
  describe('cycling the appearance control', () => {
    it('reaches every state and returns to the start', () => {
      expect(nextThemeMode('system')).toBe('light');
      expect(nextThemeMode('light')).toBe('dark');
      expect(nextThemeMode('dark')).toBe('system');
    });

    /**
     * Joy hands back `undefined` until the provider has read localStorage, and a run of that
     * state must not strand the user: the first click has to land somewhere they can cycle out of.
     */
    it('treats an unread mode as following the system', () => {
      expect(currentThemeMode(undefined)).toBe('system');
      expect(nextThemeMode(undefined)).toBe('light');
    });

    it('ignores a stored value it does not recognise', () => {
      expect(currentThemeMode('sepia')).toBe('system');
      expect(nextThemeMode('sepia')).toBe('light');
    });
  });

  describe('the line under the label', () => {
    it('names the scheme the OS resolved to, but only while following it', () => {
      expect(themeModeSummary('system', 'dark')).toBe('System (dark)');
      expect(themeModeSummary('system', 'light')).toBe('System (light)');
    });

    it('names a picked scheme on its own', () => {
      expect(themeModeSummary('light', 'light')).toBe('Light');
      expect(themeModeSummary('dark', 'dark')).toBe('Dark');
    });

    // The resolved scheme lags the click by a paint, so a picked mode must not report it.
    it('does not let a stale resolved scheme contradict a picked one', () => {
      expect(themeModeSummary('dark', 'light')).toBe('Dark');
    });
  });
});
