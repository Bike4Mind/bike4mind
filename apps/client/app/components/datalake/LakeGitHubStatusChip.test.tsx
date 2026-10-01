import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({
  flag: { current: true },
  connection: { current: null as Record<string, unknown> | null },
  queryEnabled: vi.fn(),
  ignoreEnabled: { current: false },
}));

vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({
    isAdminFeatureEnabled: (key: string) => key === 'EnableDataLakeGitHub' && h.flag.current,
    isFeatureEnabled: vi.fn(),
    isLoading: false,
  }),
}));
vi.mock('@client/app/hooks/data/githubLake', () => ({
  useLakeGitHubConnection: (_id: string, enabled: boolean) => {
    h.queryEnabled(enabled);
    return { data: enabled || h.ignoreEnabled.current ? h.connection.current : undefined };
  },
}));

import LakeGitHubStatusChip from './LakeGitHubStatusChip';

const appTheme = extendTheme({ ...getThemeConfig() });
const wrap = (ui: ReactNode) => render(<CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>);

const connection = {
  repositoryFullName: 'acme/docs',
  status: 'connected',
  enabled: true,
  lastError: null,
  syncStale: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.flag.current = true;
  h.connection.current = connection;
  h.ignoreEnabled.current = false;
});

describe('LakeGitHubStatusChip', () => {
  it('marks an org lake fed by a repository', () => {
    wrap(<LakeGitHubStatusChip lakeId="lake1" organizationId="org-1" />);
    expect(screen.getByTestId('datalake-github-status-chip-lake1')).toHaveTextContent('acme/docs');
  });

  it('never reads a personal lake', () => {
    wrap(<LakeGitHubStatusChip lakeId="lake1" />);
    expect(h.queryEnabled).toHaveBeenCalledWith(false);
    expect(screen.queryByTestId('datalake-github-status-chip-lake1')).toBeNull();
  });

  it('never reads while EnableDataLakeGitHub is off, since the route would 403', () => {
    h.flag.current = false;
    wrap(<LakeGitHubStatusChip lakeId="lake1" organizationId="org-1" />);
    expect(h.queryEnabled).toHaveBeenCalledWith(false);
    expect(screen.queryByTestId('datalake-github-status-chip-lake1')).toBeNull();
  });

  it('renders nothing with the flag off even when a stale cached connection is returned', () => {
    h.flag.current = false;
    h.ignoreEnabled.current = true;
    wrap(<LakeGitHubStatusChip lakeId="lake1" organizationId="org-1" />);
    expect(screen.queryByTestId('datalake-github-status-chip-lake1')).toBeNull();
  });

  it('renders nothing when the lake has no repository', () => {
    h.connection.current = null;
    wrap(<LakeGitHubStatusChip lakeId="lake1" organizationId="org-1" />);
    expect(screen.queryByTestId('datalake-github-status-chip-lake1')).toBeNull();
  });
});
