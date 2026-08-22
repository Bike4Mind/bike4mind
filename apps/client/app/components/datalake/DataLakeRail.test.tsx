import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import DataLakeRail from './DataLakeRail';
import type { ManageableDataLakeConfig } from '@bike4mind/common';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const lake = (over: Partial<ManageableDataLakeConfig> & { id: string; name: string }): ManageableDataLakeConfig =>
  ({
    slug: over.id,
    fileTagPrefix: `${over.id}:`,
    datalakeTag: `datalake:${over.id}`,
    isOwn: true,
    canRebuild: false,
    canManage: true,
    ...over,
  }) as ManageableDataLakeConfig;

const baseProps = {
  isLoading: false,
  isError: false,
  onRetry: vi.fn(),
  selectedLakeId: null as string | null,
  onSelect: vi.fn(),
  lakeFileCounts: {} as Record<string, number>,
  totalFileCount: 0,
};

describe('DataLakeRail', () => {
  it('lists the caller lakes with an honest count, so the page can answer "do I have any?"', () => {
    render(
      <Wrapper>
        <DataLakeRail
          {...baseProps}
          lakes={[lake({ id: 'a', name: 'Research Corpus' }), lake({ id: 'b', name: 'Design Docs' })]}
          lakeFileCounts={{ 'datalake:a': 128 }}
          totalFileCount={170}
        />
      </Wrapper>
    );

    expect(screen.getByTestId('datalake-rail-count')).toHaveTextContent('2');
    expect(screen.getByTestId('datalake-rail-lake-a')).toHaveTextContent('Research Corpus');
    expect(screen.getByTestId('datalake-rail-lake-a')).toHaveTextContent('128');
    expect(screen.getByTestId('datalake-rail-all')).toHaveTextContent('170');
  });

  it('selects a lake, and clears the scope from the all-lakes row', () => {
    const onSelect = vi.fn();
    render(
      <Wrapper>
        <DataLakeRail {...baseProps} onSelect={onSelect} lakes={[lake({ id: 'a', name: 'Research Corpus' })]} />
      </Wrapper>
    );

    fireEvent.click(screen.getByTestId('datalake-rail-lake-a'));
    expect(onSelect).toHaveBeenCalledWith('a');

    fireEvent.click(screen.getByTestId('datalake-rail-all'));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('renders a retry instead of an empty list when the read failed, and withholds the count', () => {
    // An empty rail would read as "you have no lakes", which is the lie this whole change removes.
    const onRetry = vi.fn();
    render(
      <Wrapper>
        <DataLakeRail {...baseProps} isError onRetry={onRetry} lakes={undefined} />
      </Wrapper>
    );

    expect(screen.getByTestId('datalake-rail-error')).toBeInTheDocument();
    expect(screen.queryByTestId('datalake-rail-count')).not.toBeInTheDocument();
    expect(screen.queryByTestId('datalake-rail-all')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('datalake-rail-retry-btn'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('withholds the count while loading, so it never reads as a confident zero', () => {
    render(
      <Wrapper>
        <DataLakeRail {...baseProps} isLoading lakes={undefined} />
      </Wrapper>
    );

    expect(screen.getByTestId('datalake-rail-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('datalake-rail-count')).not.toBeInTheDocument();
  });

  it('marks a lake owned by someone else, so an admin cannot mistake it for their own', () => {
    render(
      <Wrapper>
        <DataLakeRail
          {...baseProps}
          lakes={[lake({ id: 'a', name: 'Someone Elses', isOwn: false, ownerDisplayName: 'Ada' })]}
        />
      </Wrapper>
    );

    expect(screen.getByTestId('datalake-rail-owner-icon-a')).toBeInTheDocument();
  });

  it('only offers the filter box once the list is long enough to need one', () => {
    const many = Array.from({ length: 8 }, (_, i) => lake({ id: `l${i}`, name: `Lake ${i}` }));
    const { unmount } = render(
      <Wrapper>
        <DataLakeRail {...baseProps} lakes={many.slice(0, 3)} />
      </Wrapper>
    );
    expect(screen.queryByTestId('datalake-rail-search')).not.toBeInTheDocument();
    unmount();

    render(
      <Wrapper>
        <DataLakeRail {...baseProps} lakes={many} />
      </Wrapper>
    );
    const search = screen.getByTestId('datalake-rail-search');
    fireEvent.change(search, { target: { value: 'Lake 5' } });
    expect(screen.getByTestId('datalake-rail-lake-l5')).toBeInTheDocument();
    expect(screen.queryByTestId('datalake-rail-lake-l4')).not.toBeInTheDocument();
  });
});
