import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';

/**
 * Create-mode Drive selection (#1916): the wizard has no lake id yet, so picking a folder must park
 * it in wizard state rather than connect anything - that deferral is what keeps an abandoned wizard
 * from leaving a lake or a connection row behind.
 */

const h = vi.hoisted(() => ({
  selectedAccount: { current: null as { id: string; name: string; personal: boolean } | null },
  openFolderPicker: vi.fn(),
  onBeforeRedirect: undefined as ((authUrl: string) => void) | undefined,
  userId: 'user-1' as string | undefined,
}));

vi.mock('@client/app/components/Credits/AccountSelector', () => ({
  useSelectedAccount: (selector: (s: { selectedAccount: unknown }) => unknown) =>
    selector({ selectedAccount: h.selectedAccount.current }),
}));
// The picker itself (OAuth prelude + Google Picker) is not the subject here; capture the callback
// so a test can simulate a pick without a browser.
vi.mock('@client/app/hooks/data/useDriveFolderPicker', () => ({
  useDriveFolderPicker: (args: {
    onPicked: (f: { driveFolderId: string; folderName?: string }) => void;
    onBeforeRedirect?: (authUrl: string) => void;
  }) => {
    h.onBeforeRedirect = args.onBeforeRedirect;
    h.openFolderPicker.mockImplementation(() => args.onPicked({ driveFolderId: 'FOLDER1', folderName: 'Contracts' }));
    return { openFolderPicker: h.openFolderPicker, isPicking: false };
  },
}));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: { getState: () => ({ currentUser: h.userId ? { id: h.userId } : null }) },
}));
vi.mock('@client/app/hooks/data/dataLakes', () => ({ activeOrgId: () => 'org1' }));

import DrivePendingConnectAction from './DrivePendingConnectAction';
import {
  consumeDriveConnectHandoff,
  requestDrivePickerResume,
  takeDrivePickerResume,
} from '@client/app/utils/driveConnectHandoff';

const appTheme = extendTheme({ ...getThemeConfig() });
const wrap = (ui: ReactNode) => render(<CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>);

beforeEach(() => {
  vi.clearAllMocks();
  h.selectedAccount.current = { id: 'org1', name: 'Acme', personal: false };
  useDataLakeWizardStore.getState().resetWizard();
  h.userId = 'user-1';
  sessionStorage.clear();
  takeDrivePickerResume();
});

describe('DrivePendingConnectAction', () => {
  it('offers an enabled Connect button in an organization scope', () => {
    wrap(<DrivePendingConnectAction />);
    expect(screen.getByTestId('drive-connect-btn')).not.toBeDisabled();
  });

  it('says what the grant can read before the user reaches Google consent', () => {
    wrap(<DrivePendingConnectAction />);
    expect(screen.getByTestId('drive-access-disclosure')).toHaveTextContent(/whole Google Drive/);
  });

  it('parks the picked folder in wizard state instead of connecting it', () => {
    wrap(<DrivePendingConnectAction />);

    fireEvent.click(screen.getByTestId('drive-connect-btn'));

    expect(useDataLakeWizardStore.getState().pendingDriveFolder).toEqual({
      driveFolderId: 'FOLDER1',
      folderName: 'Contracts',
    });
  });

  it('shows the pending selection and what will happen to it', () => {
    useDataLakeWizardStore.setState({ pendingDriveFolder: { driveFolderId: 'FOLDER1', folderName: 'Contracts' } });

    wrap(<DrivePendingConnectAction />);

    expect(screen.getByTestId('drive-pending-selection')).toHaveTextContent('Contracts');
    expect(screen.getByTestId('drive-pending-selection')).toHaveTextContent('Connects when you create');
  });

  it('falls back to the folder id when Drive gave no name', () => {
    useDataLakeWizardStore.setState({ pendingDriveFolder: { driveFolderId: 'FOLDER1' } });

    wrap(<DrivePendingConnectAction />);

    expect(screen.getByTestId('drive-pending-selection')).toHaveTextContent('FOLDER1');
  });

  it('clears the selection, so a mistaken pick is not baked into the commit', () => {
    useDataLakeWizardStore.setState({ pendingDriveFolder: { driveFolderId: 'FOLDER1', folderName: 'Contracts' } });

    wrap(<DrivePendingConnectAction />);
    fireEvent.click(screen.getByTestId('drive-pending-clear-btn'));

    expect(useDataLakeWizardStore.getState().pendingDriveFolder).toBeNull();
  });

  it.each([
    ['a personal scope', { id: 'me', name: 'Me', personal: true }],
    ['no selected account', null],
  ])('offers an enabled Connect button in %s, since drive-sync accepts a personal lake', (_label, account) => {
    h.selectedAccount.current = account;

    wrap(<DrivePendingConnectAction />);

    expect(screen.getByTestId('drive-connect-btn')).toBeEnabled();
    expect(screen.queryByTestId('drive-connect-personal-scope-btn')).toBeNull();
  });

  it('saves the typed-in wizard config, bound to the consent URL state, before leaving for Google', () => {
    wrap(<DrivePendingConnectAction />);
    useDataLakeWizardStore.getState().setConfig({ name: 'Research' });

    h.onBeforeRedirect?.('https://accounts.google.com/auth?state=st-1');

    expect(consumeDriveConnectHandoff({ userId: 'user-1', organizationId: 'org1', oauthState: 'st-1' })).toMatchObject({
      kind: 'createWizard',
      config: { name: 'Research' },
    });
  });

  it('saves nothing when no user is signed in', () => {
    h.userId = undefined;
    wrap(<DrivePendingConnectAction />);

    h.onBeforeRedirect?.('https://accounts.google.com/auth?state=st-1');

    expect(sessionStorage.getItem('b4m:drive-connect-handoff')).toBeNull();
  });

  it('opens the folder picker once when mounted by a resumed wizard', () => {
    requestDrivePickerResume();

    const { unmount } = wrap(<DrivePendingConnectAction />);
    expect(h.openFolderPicker).toHaveBeenCalledTimes(1);

    unmount();
    wrap(<DrivePendingConnectAction />);
    expect(h.openFolderPicker).toHaveBeenCalledTimes(1);
  });

  it('does not open the picker on an ordinary mount', () => {
    wrap(<DrivePendingConnectAction />);
    expect(h.openFolderPicker).not.toHaveBeenCalled();
  });
});
