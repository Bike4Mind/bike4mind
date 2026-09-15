import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

// Pins the field split: TagViewPanel must read tagCounts (the unnarrowed field, whose
// click-through also counts personal shares), never workspaceTagCounts - see counts.ts. A future
// edit swapping the fields would otherwise leave every other test green.
const mockData = vi.fn(() => ({
  data: {
    tagCounts: [{ tag: 'fromTagsView', count: 5 }],
    workspaceTagCounts: [{ tag: 'fromWorkspaces', count: 5 }],
    namespaceCounts: [{ namespace: 'fromWorkspaces', fileCount: 5 }],
  },
  isLoading: false,
}));

vi.mock('@client/app/hooks/data/tag', () => ({
  useGetTagCounts: () => mockData(),
}));

import TagViewPanel from './TagViewPanel';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderPanel = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <TagViewPanel onFilterByTag={vi.fn()} />
    </CssVarsProvider>
  );

describe('TagViewPanel', () => {
  it('renders a tag card from tagCounts, not workspaceTagCounts', () => {
    renderPanel();

    expect(screen.getByTestId('tag-card-fromTagsView')).toBeInTheDocument();
    expect(screen.queryByTestId('tag-card-fromWorkspaces')).not.toBeInTheDocument();
  });
});
