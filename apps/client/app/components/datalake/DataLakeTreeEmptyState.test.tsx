import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

// ConnectSourceMenu reads the GitHub flag from the admin settings cache; its items are its own suite's.
vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({
    isAdminFeatureEnabled: (key: string) => key === 'EnableDataLakeGitHub',
    isFeatureEnabled: vi.fn(),
    isLoading: false,
  }),
}));
vi.mock('@client/app/components/DataLakeWizard/steps/DriveConnectAction', () => ({
  default: () => <div data-testid="drive-connect-action" />,
}));
vi.mock('@client/app/components/DataLakeWizard/steps/GitHubConnectAction', () => ({
  default: () => <div data-testid="github-connect-action" />,
}));

import DataLakeTreeEmptyState from './DataLakeTreeEmptyState';

const appTheme = extendTheme({ ...getThemeConfig() });
const wrap = (ui: ReactNode) => render(<CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>);

describe('DataLakeTreeEmptyState - connecting a source', () => {
  it('offers Connect a source beside Add files on an empty lake the user can manage', () => {
    wrap(
      <DataLakeTreeEmptyState
        variant="lake-empty"
        onAddFiles={vi.fn()}
        sourceLake={{ id: 'lake1', organizationId: 'org-1', canManage: true, isCreator: false }}
      />
    );

    expect(screen.getByTestId('datalake-tree-empty-addfiles-btn')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-connect-source-btn')).toBeInTheDocument();
  });

  it('offers it on a personal lake too', () => {
    wrap(
      <DataLakeTreeEmptyState
        variant="lake-empty"
        onAddFiles={vi.fn()}
        sourceLake={{ id: 'lake1', organizationId: null, canManage: true, isCreator: true }}
      />
    );

    expect(screen.getByTestId('datalake-connect-source-btn')).toBeInTheDocument();
  });

  it('offers no source to a user who cannot add files to the lake', () => {
    // The caller withholds onAddFiles from a non-manager; connecting is the same capability.
    wrap(
      <DataLakeTreeEmptyState
        variant="lake-empty"
        sourceLake={{ id: 'lake1', organizationId: 'org-1', canManage: true, isCreator: false }}
      />
    );

    expect(screen.queryByTestId('datalake-connect-source-btn')).toBeNull();
  });

  it('offers no source outside a single scoped empty lake', () => {
    wrap(
      <DataLakeTreeEmptyState
        variant="lakes-empty"
        onAddFiles={vi.fn()}
        sourceLake={{ id: 'lake1', organizationId: 'org-1', canManage: true, isCreator: false }}
      />
    );

    expect(screen.queryByTestId('datalake-connect-source-btn')).toBeNull();
  });

  describe('choosing a source', () => {
    const renderEmptyLake = (onAddFiles: () => void) => {
      wrap(
        <DataLakeTreeEmptyState
          variant="lake-empty"
          onAddFiles={onAddFiles}
          sourceLake={{ id: 'lake1', organizationId: 'org-1', canManage: true, isCreator: false }}
        />
      );
      fireEvent.click(screen.getByTestId('datalake-connect-source-btn'));
    };

    it('opens the GitHub connect panel in a modal, without starting the add-files wizard', () => {
      const onAddFiles = vi.fn();
      renderEmptyLake(onAddFiles);
      expect(screen.queryByTestId('lake-source-connect-modal')).toBeNull();

      fireEvent.click(screen.getByTestId('datalake-connect-source-github-item'));

      const modal = screen.getByTestId('lake-source-connect-modal');
      expect(within(modal).getByTestId('github-connect-action')).toBeInTheDocument();
      expect(onAddFiles).not.toHaveBeenCalled();
    });

    it('routes Google Drive through the add-files wizard and opens no modal', () => {
      const onAddFiles = vi.fn();
      renderEmptyLake(onAddFiles);

      fireEvent.click(screen.getByTestId('datalake-connect-source-drive-item'));

      expect(onAddFiles).toHaveBeenCalledOnce();
      expect(screen.queryByTestId('lake-source-connect-modal')).toBeNull();
    });
  });
});
