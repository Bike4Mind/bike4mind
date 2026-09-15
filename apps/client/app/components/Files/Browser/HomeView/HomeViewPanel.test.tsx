import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

// Pins the field split: HomeViewPanel must read workspaceTagCounts (the personal-share-excluded
// pair), never tagCounts (the Tags view's unnarrowed field) - see counts.ts. A future edit
// swapping the fields would otherwise leave every other test green.
const mockData = vi.fn(() => ({
  data: {
    tagCounts: [{ tag: 'fromTagsView', count: 99 }],
    workspaceTagCounts: [{ tag: 'fromWorkspaces', count: 1 }],
    namespaceCounts: [{ namespace: 'fromWorkspaces', fileCount: 1 }],
  },
  isLoading: false,
}));

vi.mock('@client/app/hooks/data/tag', () => ({
  useGetTagCounts: () => mockData(),
}));

import HomeViewPanel from './HomeViewPanel';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderPanel = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <HomeViewPanel
        onNavigateToNamespace={vi.fn()}
        onFileSelect={vi.fn()}
        selectedIds={new Set()}
        recentFiles={[]}
        isLoadingRecent={false}
      />
    </CssVarsProvider>
  );

describe('HomeViewPanel', () => {
  it('renders a workspace row from workspaceTagCounts, not tagCounts', () => {
    renderPanel();

    expect(screen.getByTestId('workspace-row-fromWorkspaces')).toBeInTheDocument();
    expect(screen.queryByTestId('workspace-row-fromTagsView')).not.toBeInTheDocument();
  });
});
