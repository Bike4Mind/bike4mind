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
}));

vi.mock('@client/app/components/Credits/AccountSelector', () => ({
  useSelectedAccount: (selector: (s: { selectedAccount: unknown }) => unknown) =>
    selector({ selectedAccount: h.selectedAccount.current }),
}));
// The picker itself (OAuth prelude + Google Picker) is not the subject here; capture the callback
// so a test can simulate a pick without a browser.
vi.mock('@client/app/hooks/data/useDriveFolderPicker', () => ({
  useDriveFolderPicker: (args: { onPicked: (f: { driveFolderId: string; folderName?: string }) => void }) => {
    h.openFolderPicker.mockImplementation(() => args.onPicked({ driveFolderId: 'FOLDER1', folderName: 'Contracts' }));
    return { openFolderPicker: h.openFolderPicker, isPicking: false };
  },
}));

import DrivePendingConnectAction from './DrivePendingConnectAction';

const appTheme = extendTheme({ ...getThemeConfig() });
const wrap = (ui: ReactNode) => render(<CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>);

beforeEach(() => {
  vi.clearAllMocks();
  h.selectedAccount.current = { id: 'org1', name: 'Acme', personal: false };
  useDataLakeWizardStore.getState().resetWizard();
});

describe('DrivePendingConnectAction', () => {
  it('offers an enabled Connect button in an organization scope', () => {
    wrap(<DrivePendingConnectAction />);
    expect(screen.getByTestId('drive-connect-btn')).not.toBeDisabled();
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

  it('disables the action in a personal scope, which drive-sync refuses', () => {
    // POST /api/data-lakes/drive-sync 400s on a lake with no organizationId, so offering this in
    // Personal scope could only ever create a lake and then fail to connect it.
    h.selectedAccount.current = { id: 'me', name: 'Me', personal: true };

    wrap(<DrivePendingConnectAction />);

    expect(screen.getByTestId('drive-connect-personal-scope-btn')).toBeDisabled();
    expect(screen.queryByTestId('drive-connect-btn')).toBeNull();
  });

  it('disables the action before any account is selected, rather than assuming an org', () => {
    h.selectedAccount.current = null;

    wrap(<DrivePendingConnectAction />);

    expect(screen.getByTestId('drive-connect-personal-scope-btn')).toBeDisabled();
  });
});
