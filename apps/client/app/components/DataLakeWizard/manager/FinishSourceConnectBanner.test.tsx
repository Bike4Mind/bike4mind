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
  openFolderPicker: vi.fn(),
  driveConnectLakeId: undefined as string | undefined,
  toastError: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { error: h.toastError } }));

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
  useLakeDriveCanManage: () => ({ data: h.canManage }),
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
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';

const appTheme = extendTheme({ ...getThemeConfig() });
const wrap = (ui: ReactNode) => render(<CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>);

const LAKE = {
  id: 'lake1',
  organizationId: 'org1',
  origin: 'connector-fed' as const,
  canManage: true,
  isCreator: false,
};
const PERSONAL_LAKE = { ...LAKE, organizationId: null, canManage: true, isCreator: true };
const DRIVE_LAKE = { ...LAKE, pendingConnector: 'googleDrive' as const };
const BANNER = 'github-finish-connect-banner-lake1';
const DRIVE_BANNER = 'googleDrive-finish-connect-banner-lake1';

beforeEach(() => {
  vi.clearAllMocks();
  h.gitHubFlag = true;
  h.canManage = true;
  h.gitHub = { isSuccess: true, data: null };
  h.drive = { isSuccess: true, data: null };
  h.gitHubEnabledArg = undefined;
  h.driveEnabledArg = undefined;
  h.beginLakeId = undefined;
  h.driveConnectLakeId = undefined;
  useDataLakeWizardStore.setState({ gitHubConnectFailure: null });
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

  it('shows on an empty connector-fed personal lake for its creator, and restarts the GitHub connect on click', () => {
    wrap(<FinishSourceConnectBanner lake={PERSONAL_LAKE} fileCount={0} />);

    expect(screen.getByTestId(BANNER)).toBeInTheDocument();
    expect(h.gitHubEnabledArg).toBe(true);
    expect(h.driveEnabledArg).toBe(true);
    fireEvent.click(screen.getByTestId('github-finish-connect-btn-lake1'));
    expect(h.beginLakeId).toBe('lake1');
    expect(h.begin).toHaveBeenCalledTimes(1);
  });

  it('shows the Drive banner on an empty connector-fed personal lake for its creator', () => {
    wrap(<FinishSourceConnectBanner lake={{ ...PERSONAL_LAKE, pendingConnector: 'googleDrive' }} fileCount={0} />);

    expect(screen.getByTestId(DRIVE_BANNER)).toBeInTheDocument();
  });

  it('hides on a personal lake for a non-creator, even one the server reports as manageable', () => {
    wrap(<FinishSourceConnectBanner lake={{ ...PERSONAL_LAKE, isCreator: false }} fileCount={0} />);

    expect(screen.queryByTestId(BANNER)).toBeNull();
    expect(h.gitHubEnabledArg).toBe(false);
    expect(h.driveEnabledArg).toBe(false);
  });

  it('hides on a personal lake for its creator when the status read reports no manage right', () => {
    h.canManage = false;
    wrap(<FinishSourceConnectBanner lake={PERSONAL_LAKE} fileCount={0} />);

    expect(screen.queryByTestId(BANNER)).toBeNull();
  });

  it.each([
    ['a personal lake the user did not create', { ...LAKE, organizationId: undefined, canManage: false }],
    ['a curated lake', { ...LAKE, origin: 'curated' as const }],
    ['a lake the user cannot manage', { ...LAKE, canManage: false }],
  ])('hides on %s and never reads its connections', (_label, lake) => {
    wrap(<FinishSourceConnectBanner lake={lake} fileCount={0} />);

    expect(screen.queryByTestId(BANNER)).toBeNull();
    expect(h.gitHubEnabledArg).toBe(false);
    expect(h.driveEnabledArg).toBe(false);
  });

  it.each([
    ['GitHub', LAKE, BANNER],
    ['Google Drive', DRIVE_LAKE, DRIVE_BANNER],
  ])(
    'hides the %s banner for an appointed org admin, who can read the status but whose connect would 404',
    (_label, lake, banner) => {
      h.canManage = false;
      wrap(<FinishSourceConnectBanner lake={lake} fileCount={0} />);

      expect(screen.queryByTestId(banner)).toBeNull();
    }
  );

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

  describe('after a failed or cancelled GitHub connect', () => {
    const REASON = 'This authorization already expired.';
    const failOn = (lakeId: string) =>
      useDataLakeWizardStore.setState({ gitHubConnectFailure: { lakeId, message: REASON } });
    const failure = () => useDataLakeWizardStore.getState().gitHubConnectFailure;

    it('shows the reason and a Try again that clears it and restarts the GitHub connect', () => {
      failOn('lake1');
      wrap(<FinishSourceConnectBanner lake={LAKE} fileCount={0} />);

      expect(screen.getByTestId(BANNER)).toBeInTheDocument();
      expect(screen.getByTestId('github-finish-connect-error-lake1')).toHaveTextContent(REASON);
      expect(h.toastError).not.toHaveBeenCalled();
      const button = screen.getByTestId('github-finish-connect-btn-lake1');
      expect(button).toHaveTextContent('Try again');
      fireEvent.click(button);
      expect(h.beginLakeId).toBe('lake1');
      expect(h.begin).toHaveBeenCalledTimes(1);
      expect(failure()).toBeNull();
    });

    it.each([
      ['a curated lake', { ...LAKE, origin: 'curated' as const }, 0],
      ['a lake that already has files', LAKE, 3],
      ['a lake pending a Drive connect', DRIVE_LAKE, 0],
    ])('falls back to a toast on %s, where Try again could not work', (_label, lake, fileCount) => {
      failOn('lake1');
      wrap(<FinishSourceConnectBanner lake={lake} fileCount={fileCount} />);

      expect(screen.queryByTestId('github-finish-connect-error-lake1')).toBeNull();
      expect(h.toastError).toHaveBeenCalledWith(REASON);
      expect(failure()).toBeNull();
    });

    it('falls back to a toast for a user who cannot connect', () => {
      h.canManage = false;
      failOn('lake1');
      wrap(<FinishSourceConnectBanner lake={LAKE} fileCount={0} />);

      expect(h.toastError).toHaveBeenCalledWith(REASON);
      expect(failure()).toBeNull();
    });

    it('waits for the connection reads before deciding', () => {
      h.gitHub = { isSuccess: false, data: undefined, isPending: true } as ReadState;
      failOn('lake1');
      wrap(<FinishSourceConnectBanner lake={LAKE} fileCount={0} />);

      expect(h.toastError).not.toHaveBeenCalled();
      expect(failure()).not.toBeNull();
    });

    it('drops a shown reason without a toast once the lake gains a source', () => {
      failOn('lake1');
      const { rerender } = wrap(<FinishSourceConnectBanner lake={LAKE} fileCount={0} />);
      expect(screen.getByTestId('github-finish-connect-error-lake1')).toBeInTheDocument();

      h.drive = { isSuccess: true, data: { id: 'drive1' } };
      rerender(
        <CssVarsProvider theme={appTheme}>
          <FinishSourceConnectBanner lake={LAKE} fileCount={0} />
        </CssVarsProvider>
      );

      expect(screen.queryByTestId(BANNER)).toBeNull();
      expect(h.toastError).not.toHaveBeenCalled();
      expect(failure()).toBeNull();
    });

    it('leaves other lakes alone', () => {
      failOn('lake2');
      wrap(<FinishSourceConnectBanner lake={LAKE} fileCount={0} />);

      expect(screen.queryByTestId('github-finish-connect-error-lake1')).toBeNull();
      expect(screen.getByTestId('github-finish-connect-btn-lake1')).toHaveTextContent('Finish connecting GitHub');
      expect(h.toastError).not.toHaveBeenCalled();
      expect(failure()).not.toBeNull();
    });

    it('goes back to the plain banner once dismissed', () => {
      failOn('lake1');
      wrap(<FinishSourceConnectBanner lake={LAKE} fileCount={0} />);

      fireEvent.click(screen.getByTestId('github-finish-connect-dismiss-btn-lake1'));
      expect(failure()).toBeNull();
      expect(screen.queryByTestId('github-finish-connect-error-lake1')).toBeNull();
      expect(screen.getByTestId('github-finish-connect-btn-lake1')).toHaveTextContent('Finish connecting GitHub');
      expect(h.toastError).not.toHaveBeenCalled();
    });
  });
});
