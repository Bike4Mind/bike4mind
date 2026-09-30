import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({
  gitHubFlag: { current: true },
  driveConnection: { current: null as { id: string } | null },
  gitHubConnection: { current: null as { id: string } | null },
  gitHubQueryEnabled: vi.fn(),
}));

vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({
    isAdminFeatureEnabled: (key: string) => key === 'EnableDataLakeGitHub' && h.gitHubFlag.current,
    isFeatureEnabled: vi.fn(),
    isLoading: false,
  }),
}));
vi.mock('@client/app/hooks/data/googleDrive', () => ({
  useLakeDriveConnection: () => ({ data: h.driveConnection.current }),
}));
vi.mock('@client/app/hooks/data/githubLake', () => ({
  useLakeGitHubConnection: (_id: string, enabled: boolean) => {
    h.gitHubQueryEnabled(enabled);
    // A disabled query still serves its cache, which is the stale case the flag guard exists for.
    return { data: h.gitHubConnection.current };
  },
}));
vi.mock('./DriveConnectAction', () => ({ default: () => <div data-testid="drive-connect-action" /> }));
vi.mock('./GitHubConnectAction', () => ({ default: () => <div data-testid="github-connect-action" /> }));

import LakeSourceConnectActions from './LakeSourceConnectActions';

const appTheme = extendTheme({ ...getThemeConfig() });
const wrap = (ui: ReactNode) => render(<CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>);

beforeEach(() => {
  vi.clearAllMocks();
  h.gitHubFlag.current = true;
  h.driveConnection.current = null;
  h.gitHubConnection.current = null;
});

describe('LakeSourceConnectActions', () => {
  it('offers both sources on an unconnected lake', () => {
    wrap(<LakeSourceConnectActions lake={{ id: 'lake1' }} />);
    expect(screen.getByTestId('drive-connect-action')).toBeInTheDocument();
    expect(screen.getByTestId('github-connect-action')).toBeInTheDocument();
  });

  it('shows only Drive, and never reads the GitHub routes, while EnableDataLakeGitHub is off', () => {
    h.gitHubFlag.current = false;
    h.gitHubConnection.current = { id: 'gh1' };
    wrap(<LakeSourceConnectActions lake={{ id: 'lake1' }} />);
    expect(screen.getByTestId('drive-connect-action')).toBeInTheDocument();
    expect(screen.queryByTestId('github-connect-action')).toBeNull();
    expect(h.gitHubQueryEnabled).toHaveBeenCalledWith(false);
  });

  it('shows only Drive once a Drive folder feeds the lake (one connector per lake)', () => {
    h.driveConnection.current = { id: 'drive1' };
    wrap(<LakeSourceConnectActions lake={{ id: 'lake1' }} />);
    expect(screen.getByTestId('drive-connect-action')).toBeInTheDocument();
    expect(screen.queryByTestId('github-connect-action')).toBeNull();
  });

  it('shows only GitHub once a repository feeds the lake', () => {
    h.gitHubConnection.current = { id: 'gh1' };
    wrap(<LakeSourceConnectActions lake={{ id: 'lake1' }} />);
    expect(screen.getByTestId('github-connect-action')).toBeInTheDocument();
    expect(screen.queryByTestId('drive-connect-action')).toBeNull();
  });
});
