import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({
  flag: { current: true },
  drive: { current: null as Record<string, unknown> | null },
  gitHub: { current: null as Record<string, unknown> | null },
  driveEnabled: vi.fn(),
}));

vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({
    isAdminFeatureEnabled: (key: string) => key === 'EnableDataLakeGitHub' && h.flag.current,
    isFeatureEnabled: vi.fn(),
    isLoading: false,
  }),
}));
vi.mock('@client/app/hooks/data/googleDrive', () => ({
  useLakeDriveConnection: (_id: string, enabled: boolean) => {
    h.driveEnabled(enabled);
    return { data: enabled ? h.drive.current : undefined };
  },
}));
vi.mock('@client/app/hooks/data/githubLake', () => ({
  useLakeGitHubConnection: (_id: string, enabled: boolean) => ({ data: enabled ? h.gitHub.current : undefined }),
}));

import LakeSyncStatus from './LakeSyncStatus';

const appTheme = extendTheme({ ...getThemeConfig() });
const wrap = (ui: ReactNode) => render(<CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>);
const when = new Date(Date.now() - 5 * 60_000).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  h.flag.current = true;
  h.drive.current = null;
  h.gitHub.current = null;
});

describe('LakeSyncStatus', () => {
  it('shows the GitHub last synced time', () => {
    h.gitHub.current = { lastSyncedAt: when };
    wrap(<LakeSyncStatus lakeId="lake1" organizationId="org-1" isCreator />);
    expect(screen.getByTestId('datalake-last-synced-lake1').textContent).toMatch(/^Last synced /);
  });

  it('shows the Drive attempt wording when the last run failed', () => {
    h.drive.current = { lastPolledAt: when, lastError: 'boom' };
    wrap(<LakeSyncStatus lakeId="lake1" organizationId="org-1" isCreator />);
    expect(screen.getByTestId('datalake-last-synced-lake1').textContent).toMatch(/^Last sync attempt /);
  });

  it('shows a line per source when both are attached', () => {
    h.drive.current = { lastPolledAt: when, lastError: null };
    h.gitHub.current = { lastSyncedAt: null };
    wrap(<LakeSyncStatus lakeId="lake1" organizationId="org-1" isCreator />);
    const text = screen.getByTestId('datalake-last-synced-lake1').textContent;
    expect(text).toContain('Last synced');
    expect(text).toContain('Not synced yet');
  });

  it('renders nothing without a connection', () => {
    wrap(<LakeSyncStatus lakeId="lake1" organizationId="org-1" isCreator />);
    expect(screen.queryByTestId('datalake-last-synced-lake1')).toBeNull();
  });

  it('ignores GitHub while the flag is off', () => {
    h.flag.current = false;
    h.gitHub.current = { lastSyncedAt: when };
    wrap(<LakeSyncStatus lakeId="lake1" organizationId="org-1" isCreator />);
    expect(screen.queryByTestId('datalake-last-synced-lake1')).toBeNull();
  });

  it('does not read Drive for someone else personal lake', () => {
    h.drive.current = { lastPolledAt: when, lastError: null };
    wrap(<LakeSyncStatus lakeId="lake1" isCreator={false} />);
    expect(h.driveEnabled).toHaveBeenCalledWith(false);
    expect(screen.queryByTestId('datalake-last-synced-lake1')).toBeNull();
  });
});
