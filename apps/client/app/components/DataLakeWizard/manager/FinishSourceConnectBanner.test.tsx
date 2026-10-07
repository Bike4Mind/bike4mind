import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

type ReadState = { isSuccess: boolean; data: unknown };

const h = vi.hoisted(() => ({
  gitHubFlag: true,
  gitHub: { isSuccess: true, data: null } as ReadState,
  drive: { isSuccess: true, data: null } as ReadState,
  gitHubEnabledArg: undefined as boolean | undefined,
  driveEnabledArg: undefined as boolean | undefined,
  begin: vi.fn(),
  beginLakeId: undefined as string | undefined,
  openFolderPicker: vi.fn(),
  driveConnectLakeId: undefined as string | undefined,
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

vi.mock('@client/app/hooks/data/useLakeDriveFolderConnect', () => ({
  useLakeDriveFolderConnect: (lakeId: string) => {
    h.driveConnectLakeId = lakeId;
    return { openFolderPicker: h.openFolderPicker, isPicking: false, isConnecting: false };
  },
}));

import FinishSourceConnectBanner from './FinishSourceConnectBanner';

const appTheme = extendTheme({ ...getThemeConfig() });
const wrap = (ui: ReactNode) => render(<CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>);

const LAKE = {
  id: 'lake1',
  organizationId: 'org1',
  origin: 'connector-fed' as const,
  canManage: true,
  isCreator: false,
};
const DRIVE_LAKE = { ...LAKE, pendingConnector: 'googleDrive' as const };
const BANNER = 'github-finish-connect-banner-lake1';
const DRIVE_BANNER = 'googleDrive-finish-connect-banner-lake1';

beforeEach(() => {
  vi.clearAllMocks();
  h.gitHubFlag = true;
  h.gitHub = { isSuccess: true, data: null };
  h.drive = { isSuccess: true, data: null };
  h.gitHubEnabledArg = undefined;
  h.driveEnabledArg = undefined;
  h.beginLakeId = undefined;
  h.driveConnectLakeId = undefined;
});

describe('FinishSourceConnectBanner', () => {
  it('shows on an empty connector-fed org lake with no source, and restarts the GitHub connect on click', () => {
    wrap(<FinishSourceConnectBanner lake={LAKE} fileCount={0} />);

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
    wrap(<FinishSourceConnectBanner lake={lake} fileCount={0} />);

    expect(screen.queryByTestId(BANNER)).toBeNull();
    expect(h.gitHubEnabledArg).toBe(false);
    expect(h.driveEnabledArg).toBe(false);
  });

  it.each([
    ['no pendingConnector', undefined],
    ['pendingConnector github', 'github' as const],
  ])('targets GitHub with %s', (_label, pendingConnector) => {
    wrap(<FinishSourceConnectBanner lake={{ ...LAKE, pendingConnector }} fileCount={0} />);

    expect(screen.getByTestId(BANNER)).toHaveTextContent('pick the repository that feeds it');
    expect(screen.queryByTestId(DRIVE_BANNER)).toBeNull();
    fireEvent.click(screen.getByTestId('github-finish-connect-btn-lake1'));
    expect(h.begin).toHaveBeenCalledTimes(1);
    expect(h.driveConnectLakeId).toBeUndefined();
  });

  it('targets Google Drive on a lake pending a Drive connect, and opens the folder picker on click', () => {
    wrap(<FinishSourceConnectBanner lake={DRIVE_LAKE} fileCount={0} />);

    expect(screen.queryByTestId(BANNER)).toBeNull();
    const banner = screen.getByTestId(DRIVE_BANNER);
    expect(banner).toHaveTextContent('Finish connecting Google Drive to pick the folder that feeds it');
    const button = screen.getByTestId('googleDrive-finish-connect-btn-lake1');
    expect(button).toHaveTextContent('Finish connecting Google Drive');
    fireEvent.click(button);
    expect(h.driveConnectLakeId).toBe('lake1');
    expect(h.openFolderPicker).toHaveBeenCalledTimes(1);
    expect(h.beginLakeId).toBeUndefined();
    expect(h.begin).not.toHaveBeenCalled();
  });

  it.each([
    ['no GitHub binding', false, true],
    ['a GitHub binding', true, false],
    ['an unknown GitHub binding', undefined, false],
  ])(
    'with EnableDataLakeGitHub off, decides the Drive banner from the list signal: %s',
    (_label, hasGitHubConnection, shown) => {
      // The GitHub read route 403s with the flag off, so the list's flag-free signal stands in for it.
      h.gitHubFlag = false;
      h.gitHub = { isSuccess: false, data: undefined };
      wrap(<FinishSourceConnectBanner lake={{ ...DRIVE_LAKE, hasGitHubConnection }} fileCount={0} />);

      expect(screen.queryByTestId(DRIVE_BANNER) !== null).toBe(shown);
      expect(h.gitHubEnabledArg).toBe(false);
      expect(h.driveEnabledArg).toBe(true);
    }
  );

  it('with EnableDataLakeGitHub on, trusts the live GitHub read over the list signal', () => {
    h.gitHub = { isSuccess: true, data: { id: 'conn1' } };
    wrap(<FinishSourceConnectBanner lake={{ ...DRIVE_LAKE, hasGitHubConnection: false }} fileCount={0} />);

    expect(screen.queryByTestId(DRIVE_BANNER)).toBeNull();
  });

  it.each([
    ['the GitHub read is pending or failed', () => (h.gitHub = { isSuccess: false, data: undefined })],
    ['the Drive read is pending or failed', () => (h.drive = { isSuccess: false, data: undefined })],
  ])('hides the Drive banner while %s', (_label, arrange) => {
    arrange();
    wrap(<FinishSourceConnectBanner lake={DRIVE_LAKE} fileCount={0} />);

    expect(screen.queryByTestId(DRIVE_BANNER)).toBeNull();
    expect(h.gitHubEnabledArg).toBe(true);
    expect(h.driveEnabledArg).toBe(true);
  });

  it('renders the Drive access disclosure on the Drive banner only', () => {
    const { unmount } = wrap(<FinishSourceConnectBanner lake={DRIVE_LAKE} fileCount={0} />);
    expect(screen.getByTestId(DRIVE_BANNER)).toContainElement(screen.getByTestId('drive-access-disclosure'));
    unmount();

    wrap(<FinishSourceConnectBanner lake={LAKE} fileCount={0} />);
    expect(screen.getByTestId(BANNER)).toBeInTheDocument();
    expect(screen.queryByTestId('drive-access-disclosure')).toBeNull();
  });

  it('hides the Drive banner on a lake the user cannot manage, without reading connections', () => {
    wrap(<FinishSourceConnectBanner lake={{ ...DRIVE_LAKE, canManage: false }} fileCount={0} />);

    expect(screen.queryByTestId(DRIVE_BANNER)).toBeNull();
    expect(h.gitHubEnabledArg).toBe(false);
    expect(h.driveEnabledArg).toBe(false);
  });

  it.each([
    ['a GitHub repository', () => (h.gitHub = { isSuccess: true, data: { id: 'conn1' } })],
    ['a Drive folder', () => (h.drive = { isSuccess: true, data: { id: 'drive1' } })],
  ])('hides the Drive banner once %s is connected', (_label, arrange) => {
    arrange();
    wrap(<FinishSourceConnectBanner lake={DRIVE_LAKE} fileCount={0} />);

    expect(screen.queryByTestId(DRIVE_BANNER)).toBeNull();
  });

  it.each([
    ['the lake already has files', 3],
    ['the file count is still loading', undefined],
  ])('hides the Drive banner when %s', (_label, fileCount) => {
    wrap(<FinishSourceConnectBanner lake={DRIVE_LAKE} fileCount={fileCount} />);

    expect(screen.queryByTestId(DRIVE_BANNER)).toBeNull();
  });

  it('hides, without reading connections, while EnableDataLakeGitHub is off', () => {
    h.gitHubFlag = false;
    wrap(<FinishSourceConnectBanner lake={LAKE} fileCount={0} />);

    expect(screen.queryByTestId(BANNER)).toBeNull();
    expect(h.gitHubEnabledArg).toBe(false);
  });

  it('hides once a GitHub repository is connected', () => {
    h.gitHub = { isSuccess: true, data: { id: 'conn1' } };
    wrap(<FinishSourceConnectBanner lake={LAKE} fileCount={0} />);

    expect(screen.queryByTestId(BANNER)).toBeNull();
  });

  it('hides on a Drive-fed lake', () => {
    h.drive = { isSuccess: true, data: { id: 'drive1' } };
    wrap(<FinishSourceConnectBanner lake={LAKE} fileCount={0} />);

    expect(screen.queryByTestId(BANNER)).toBeNull();
  });

  it.each([
    ['the GitHub read is pending or failed', () => (h.gitHub = { isSuccess: false, data: undefined })],
    ['the Drive read is pending or failed', () => (h.drive = { isSuccess: false, data: undefined })],
  ])('hides while %s', (_label, arrange) => {
    arrange();
    wrap(<FinishSourceConnectBanner lake={LAKE} fileCount={0} />);

    expect(screen.queryByTestId(BANNER)).toBeNull();
  });

  it.each([
    ['the lake already has files', 3],
    ['the file count is still loading', undefined],
  ])('hides when %s', (_label, fileCount) => {
    wrap(<FinishSourceConnectBanner lake={LAKE} fileCount={fileCount} />);

    expect(screen.queryByTestId(BANNER)).toBeNull();
  });
});
