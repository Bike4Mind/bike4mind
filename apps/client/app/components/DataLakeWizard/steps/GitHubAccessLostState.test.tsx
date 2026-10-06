import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { LakeGitHubConnection } from '@client/app/hooks/data/githubLake';
import GitHubAccessLostState from './GitHubAccessLostState';

const appTheme = extendTheme({ ...getThemeConfig() });
const wrap = (ui: ReactNode) => render(<CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>);

const FIX_URL = 'https://github.com/apps/b4m-lake/installations/new/permissions?target_id=501';
const SETTINGS_URL = 'https://github.com/settings/installations/42';

const accessLost = (over: Partial<LakeGitHubConnection> = {}): LakeGitHubConnection => ({
  id: 'c1',
  accountLogin: 'acme',
  repositoryId: 100,
  repositoryFullName: 'acme/docs',
  connectedBy: 'u1',
  connectedAt: '2026-01-01T00:00:00.000Z',
  enabled: true,
  status: 'access_lost',
  lastError: 'The GitHub App can no longer read this repository.',
  defaultBranch: 'main',
  lastSyncedAt: null,
  syncStale: false,
  fileCount: 3,
  disconnecting: false,
  disconnectStalled: false,
  fixAccessUrl: FIX_URL,
  ...over,
});

describe('GitHubAccessLostState', () => {
  it('names the repository and the account the App lost access through', () => {
    wrap(<GitHubAccessLostState connection={accessLost()} onDisconnect={vi.fn()} />);

    expect(screen.getByTestId('github-access-lost-title')).toHaveTextContent('Access lost to acme/docs');
    expect(screen.getByTestId('github-access-lost-detail')).toHaveTextContent(/uninstalled from acme/);
  });

  it('reassures that already-ingested files survive, so Disconnect is not read as the only way out', () => {
    wrap(<GitHubAccessLostState connection={accessLost()} onDisconnect={vi.fn()} />);

    expect(screen.getByTestId('github-access-lost-detail')).toHaveTextContent(
      /Files already in the lake are untouched/
    );
    expect(screen.getByTestId('github-access-lost-resync-hint')).toHaveTextContent(/Re-sync/);
  });

  // The issue's load-bearing constraint: settingsUrl 404s for anyone who does not own the account.
  it('sends Fix on GitHub to the targeted install page, never to the owner-only settings page', () => {
    wrap(<GitHubAccessLostState connection={accessLost()} onDisconnect={vi.fn()} />);

    const fix = screen.getByTestId('github-access-lost-fix-btn');
    expect(fix).toHaveAttribute('href', FIX_URL);
    expect(fix.getAttribute('href')).not.toContain('settings/installations');
    expect(fix.getAttribute('href')).not.toBe(SETTINGS_URL);
  });

  it('opens Fix on GitHub in a new tab without handing GitHub the opener', () => {
    wrap(<GitHubAccessLostState connection={accessLost()} onDisconnect={vi.fn()} />);

    const fix = screen.getByTestId('github-access-lost-fix-btn');
    expect(fix).toHaveAttribute('target', '_blank');
    expect(fix).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('disables Fix on GitHub, with no href to follow, when the App is unconfigured', () => {
    wrap(<GitHubAccessLostState connection={accessLost({ fixAccessUrl: null })} onDisconnect={vi.fn()} />);

    const fix = screen.getByTestId('github-access-lost-fix-btn');
    expect(fix).toBeDisabled();
    expect(fix).not.toHaveAttribute('href');
  });

  it('hands Disconnect back to the caller rather than purging anything itself', () => {
    const onDisconnect = vi.fn();
    wrap(<GitHubAccessLostState connection={accessLost()} onDisconnect={onDisconnect} />);

    fireEvent.click(screen.getByTestId('github-access-lost-disconnect-btn'));
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it('disables Disconnect while the caller is already confirming one', () => {
    const onDisconnect = vi.fn();
    wrap(<GitHubAccessLostState connection={accessLost()} onDisconnect={onDisconnect} disconnectDisabled />);

    const disconnect = screen.getByTestId('github-access-lost-disconnect-btn');
    expect(disconnect).toBeDisabled();
    fireEvent.click(disconnect);
    expect(onDisconnect).not.toHaveBeenCalled();
  });
});
