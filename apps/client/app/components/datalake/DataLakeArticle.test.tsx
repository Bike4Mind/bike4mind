import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import DataLakeArticle from './DataLakeArticle';
import { DEFAULT_DATA_LAKE_SURFACE_TOKENS } from './surfaceTokens';

// The content hook hits react-query; stub it so the empty state renders without a provider.
vi.mock('@client/app/hooks/data/fabFiles', () => ({
  useGetFabFileContent: () => ({ data: undefined, isLoading: false }),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('DataLakeArticle - create-first empty state (#837)', () => {
  it('renders a create CTA in the empty state when onCreate is provided and invokes it', () => {
    const onCreate = vi.fn();
    render(
      <Wrapper>
        <DataLakeArticle file={null} onAskAbout={vi.fn()} onCreate={onCreate} />
      </Wrapper>
    );

    const cta = screen.getByTestId('datalake-empty-create-btn');
    expect(cta).toBeInTheDocument();

    fireEvent.click(cta);
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('shows the default idle copy and no CTA when onCreate is absent', () => {
    render(
      <Wrapper>
        <DataLakeArticle file={null} onAskAbout={vi.fn()} />
      </Wrapper>
    );

    expect(screen.queryByTestId('datalake-empty-create-btn')).not.toBeInTheDocument();
    expect(screen.getByText(DEFAULT_DATA_LAKE_SURFACE_TOKENS.copy.emptyTitle)).toBeInTheDocument();
  });
});
