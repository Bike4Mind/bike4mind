import { CssVarsProvider } from '@mui/joy/styles';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AuthState } from '@shared/auth';
import { SettingsNavItem, SettingsScreen } from './SettingsPanel';

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

  it('holds the two settings that are about the app itself', () => {
    expect(html).toContain('data-entry="server"');
    expect(html).toContain('data-entry="updates"');
  });

  it('mounts the same server picker and updater, not copies of them', () => {
    expect(html).toContain('data-testid="environment-select-btn"');
    expect(html).toContain('data-testid="update-settings"');
  });

  /** The caption came with the picker: it is the one thing the picker cannot say about itself. */
  it('keeps the line saying how far the server choice reaches', () => {
    expect(html).toContain('Every conversation in this app talks to one server.');
  });

  it('says which half of the settings it owns', () => {
    expect(html).toContain('What this app connects to, and how it keeps itself up to date.');
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
    expect(early).toContain('data-entry="updates"');
    expect(early).not.toContain('data-entry="server"');
  });
});

describe('the Settings nav row', () => {
  it('opens the screen and keeps its stable hook', () => {
    expect(markup(<SettingsNavItem auth={signedIn} onOpen={() => {}} />)).toContain('data-testid="chat-settings-btn"');
  });

  /**
   * The chip moved here with the update entry. Nothing is pending in a renderer that has not
   * talked to main yet, so it is absent - but it is this row's to draw, not Customize's.
   */
  it('shows no attention badge when no update is waiting', () => {
    expect(markup(<SettingsNavItem auth={signedIn} onOpen={() => {}} />)).not.toContain('settings-attention-chip');
  });
});
