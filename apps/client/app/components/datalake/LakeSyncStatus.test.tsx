import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
const now = new Date('2026-01-01T12:00:00Z');
const when = new Date(now.getTime() - 5 * 60_000).toISOString();

beforeEach(() => {
  vi.useFakeTimers().setSystemTime(now);
  vi.clearAllMocks();
  h.flag.current = true;
  h.drive.current = null;
  h.gitHub.current = null;
});
afterEach(() => vi.useRealTimers());

describe('LakeSyncStatus', () => {
  it('shows the GitHub last synced time', () => {
    h.gitHub.current = { lastSyncedAt: when };
    wrap(<LakeSyncStatus lakeId="lake1" organizationId="org-1" isCreator />);
    expect(screen.getByTestId('datalake-last-synced-lake1').textContent).toBe('Last synced 5 minutes ago');
  });

  it('shows the Drive attempt wording when the last run failed', () => {
    h.drive.current = { lastPolledAt: when, lastError: 'boom' };
    wrap(<LakeSyncStatus lakeId="lake1" organizationId="org-1" isCreator />);
    expect(screen.getByTestId('datalake-last-synced-lake1').textContent).toBe('Last sync attempt 5 minutes ago');
  });

  it('labels a line per source when both are attached', () => {
    h.drive.current = { lastPolledAt: when, lastError: null };
    h.gitHub.current = { lastSyncedAt: null };
    wrap(<LakeSyncStatus lakeId="lake1" organizationId="org-1" isCreator />);
    const lines = Array.from(screen.getByTestId('datalake-last-synced-lake1').children, el => el.textContent);
    expect(lines).toEqual(['Drive: Last synced 5 minutes ago', 'GitHub: Not synced yet']);
  });

  it('keeps both lines when the sources read the same', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.drive.current = { lastPolledAt: null, lastError: null };
    h.gitHub.current = { lastSyncedAt: null };
    wrap(<LakeSyncStatus lakeId="lake1" organizationId="org-1" isCreator />);
    expect(screen.getByTestId('datalake-last-synced-lake1').children).toHaveLength(2);
    expect(errorSpy.mock.calls.flat().some(arg => String(arg).includes('same key'))).toBe(false);
    errorSpy.mockRestore();
  });

  it('reads Drive for the creator of a personal lake', () => {
    h.drive.current = { lastPolledAt: when, lastError: null };
    wrap(<LakeSyncStatus lakeId="lake1" isCreator />);
    expect(h.driveEnabled).toHaveBeenCalledWith(true);
    expect(screen.getByTestId('datalake-last-synced-lake1').textContent).toBe('Last synced 5 minutes ago');
  });

  it('reads GitHub for the creator of a personal lake', () => {
    h.gitHub.current = { lastSyncedAt: when };
    wrap(<LakeSyncStatus lakeId="lake1" isCreator />);
    expect(screen.getByTestId('datalake-last-synced-lake1').textContent).toBe('Last synced 5 minutes ago');
  });

  it('does not read GitHub for someone else personal lake', () => {
    h.gitHub.current = { lastSyncedAt: when };
    wrap(<LakeSyncStatus lakeId="lake1" isCreator={false} />);
    expect(screen.queryByTestId('datalake-last-synced-lake1')).toBeNull();
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
