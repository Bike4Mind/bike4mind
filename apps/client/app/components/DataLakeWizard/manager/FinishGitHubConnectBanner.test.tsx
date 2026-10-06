import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

type ReadState = { isSuccess: boolean; data: unknown };

const h = vi.hoisted(() => ({
  gitHubFlag: true,
  canManage: true,
  gitHub: { isSuccess: true, data: null } as ReadState,
  drive: { isSuccess: true, data: null } as ReadState,
  gitHubEnabledArg: undefined as boolean | undefined,
  driveEnabledArg: undefined as boolean | undefined,
  begin: vi.fn(),
  beginLakeId: undefined as string | undefined,
}));

vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({
    isAdminFeatureEnabled: (name: string) => name === 'EnableDataLakeGitHub' && h.gitHubFlag,
  }),
}));
vi.mock('@client/app/hooks/data/githubLake', () => ({
  useLakeGitHubConnection: (_id: string, enabled: boolean) => {
    h.gitHubEnabledArg = enabled;
    return h.gitHub;
  },
  useLakeGitHubCanManage: () => ({ data: h.canManage }),
}));
vi.mock('@client/app/hooks/data/googleDrive', () => ({
  useLakeDriveConnection: (_id: string, enabled: boolean) => {
    h.driveEnabledArg = enabled;
    return h.drive;
  },
}));
vi.mock('@client/app/hooks/data/useBeginLakeGitHubConnect', () => ({
  useBeginLakeGitHubConnect: (lakeId: string) => {
    h.beginLakeId = lakeId;
    return { begin: h.begin, isPending: false };
  },
}));

import FinishGitHubConnectBanner from './FinishGitHubConnectBanner';

const appTheme = extendTheme({ ...getThemeConfig() });
const wrap = (ui: ReactNode) => render(<CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>);

const LAKE = {
  id: 'lake1',
  organizationId: 'org1',
  origin: 'connector-fed' as const,
  canManage: true,
  isCreator: false,
};
const BANNER = 'github-finish-connect-banner-lake1';

beforeEach(() => {
  vi.clearAllMocks();
  h.gitHubFlag = true;
  h.canManage = true;
  h.gitHub = { isSuccess: true, data: null };
  h.drive = { isSuccess: true, data: null };
  h.gitHubEnabledArg = undefined;
  h.driveEnabledArg = undefined;
});

describe('FinishGitHubConnectBanner', () => {
  it('shows on an empty connector-fed org lake with no source, and restarts the GitHub connect on click', () => {
    wrap(<FinishGitHubConnectBanner lake={LAKE} fileCount={0} />);

    expect(screen.getByTestId(BANNER)).toBeInTheDocument();
    const button = screen.getByTestId('github-finish-connect-btn-lake1');
    expect(button).toHaveTextContent('Finish connecting GitHub');
    fireEvent.click(button);
    expect(h.beginLakeId).toBe('lake1');
    expect(h.begin).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a personal lake', { ...LAKE, organizationId: undefined }],
    ['a curated lake', { ...LAKE, origin: 'curated' as const }],
    ['a lake the user cannot manage', { ...LAKE, canManage: false }],
  ])('hides on %s and never reads its connections', (_label, lake) => {
    wrap(<FinishGitHubConnectBanner lake={lake} fileCount={0} />);

    expect(screen.queryByTestId(BANNER)).toBeNull();
    expect(h.gitHubEnabledArg).toBe(false);
    expect(h.driveEnabledArg).toBe(false);
  });

  it('hides, without reading connections, while EnableDataLakeGitHub is off', () => {
    h.gitHubFlag = false;
    wrap(<FinishGitHubConnectBanner lake={LAKE} fileCount={0} />);

    expect(screen.queryByTestId(BANNER)).toBeNull();
    expect(h.gitHubEnabledArg).toBe(false);
  });

  it('hides for an appointed org admin, who can read the status but whose connect would 404', () => {
    h.canManage = false;
    wrap(<FinishGitHubConnectBanner lake={LAKE} fileCount={0} />);

    expect(screen.queryByTestId(BANNER)).toBeNull();
  });

  it('hides once a GitHub repository is connected', () => {
    h.gitHub = { isSuccess: true, data: { id: 'conn1' } };
    wrap(<FinishGitHubConnectBanner lake={LAKE} fileCount={0} />);

    expect(screen.queryByTestId(BANNER)).toBeNull();
  });

  it('hides on a Drive-fed lake', () => {
    h.drive = { isSuccess: true, data: { id: 'drive1' } };
    wrap(<FinishGitHubConnectBanner lake={LAKE} fileCount={0} />);

    expect(screen.queryByTestId(BANNER)).toBeNull();
  });

  it.each([
    ['the GitHub read is pending or failed', () => (h.gitHub = { isSuccess: false, data: undefined })],
    ['the Drive read is pending or failed', () => (h.drive = { isSuccess: false, data: undefined })],
  ])('hides while %s', (_label, arrange) => {
    arrange();
    wrap(<FinishGitHubConnectBanner lake={LAKE} fileCount={0} />);

    expect(screen.queryByTestId(BANNER)).toBeNull();
  });

  it.each([
    ['the lake already has files', 3],
    ['the file count is still loading', undefined],
  ])('hides when %s', (_label, fileCount) => {
    wrap(<FinishGitHubConnectBanner lake={LAKE} fileCount={fileCount} />);

    expect(screen.queryByTestId(BANNER)).toBeNull();
  });
});
