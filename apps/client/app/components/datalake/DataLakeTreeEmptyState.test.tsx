import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

// ConnectSourceMenu reads the GitHub flag from the admin settings cache; its items are its own suite's.
vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isAdminFeatureEnabled: () => false, isFeatureEnabled: vi.fn(), isLoading: false }),
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
        sourceLake={{ organizationId: 'org-1', isCreator: false }}
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
        sourceLake={{ organizationId: null, isCreator: true }}
      />
    );

    expect(screen.getByTestId('datalake-connect-source-btn')).toBeInTheDocument();
  });

  it('offers no source to a user who cannot add files to the lake', () => {
    // The caller withholds onAddFiles from a non-manager; connecting is the same capability.
    wrap(<DataLakeTreeEmptyState variant="lake-empty" sourceLake={{ organizationId: 'org-1', isCreator: false }} />);

    expect(screen.queryByTestId('datalake-connect-source-btn')).toBeNull();
  });

  it('offers no source outside a single scoped empty lake', () => {
    wrap(
      <DataLakeTreeEmptyState
        variant="lakes-empty"
        onAddFiles={vi.fn()}
        sourceLake={{ organizationId: 'org-1', isCreator: false }}
      />
    );

    expect(screen.queryByTestId('datalake-connect-source-btn')).toBeNull();
  });
});
