import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import DataLakeLakePicker from './DataLakeLakePicker';
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

const renderPicker = (props: Partial<React.ComponentProps<typeof DataLakeLakePicker>> = {}) => {
  const result = render(
    <Wrapper>
      <DataLakeLakePicker {...baseProps} lakes={[]} {...props} />
    </Wrapper>
  );
  return result;
};

/** The list lives behind the trigger, so every list assertion opens the menu first. */
const openMenu = () => fireEvent.click(screen.getByTestId('datalake-lake-picker-btn'));

describe('DataLakeLakePicker', () => {
  it('lists the caller lakes with an honest count, so the surface can answer "do I have any?"', () => {
    renderPicker({
      lakes: [lake({ id: 'a', name: 'Research Corpus' }), lake({ id: 'b', name: 'Design Docs' })],
      lakeFileCounts: { 'datalake:a': 128 },
      totalFileCount: 170,
    });
    openMenu();

    expect(screen.getByTestId('datalake-lake-picker-lake-count')).toHaveTextContent('2 lakes');
    expect(screen.getByTestId('datalake-lake-picker-lake-a')).toHaveTextContent('Research Corpus');
    expect(screen.getByTestId('datalake-lake-picker-lake-a')).toHaveTextContent('128');
    expect(screen.getByTestId('datalake-lake-picker-all')).toHaveTextContent('170');
  });

  it('selects a lake, and clears the scope from the all-lakes row', () => {
    const onSelect = vi.fn();
    renderPicker({ onSelect, lakes: [lake({ id: 'a', name: 'Research Corpus' })] });

    openMenu();
    fireEvent.click(screen.getByTestId('datalake-lake-picker-lake-a'));
    expect(onSelect).toHaveBeenCalledWith('a');

    openMenu();
    fireEvent.click(screen.getByTestId('datalake-lake-picker-all'));
    // null is the explicit all-lakes scope, not an absence of choice.
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it('names the scoped lake on the trigger, so the current scope reads without opening the menu', () => {
    renderPicker({
      selectedLakeId: 'a',
      lakes: [lake({ id: 'a', name: 'Research Corpus' })],
      lakeFileCounts: { 'datalake:a': 128 },
      totalFileCount: 170,
    });

    const trigger = screen.getByTestId('datalake-lake-picker-btn');
    expect(trigger).toHaveTextContent('Research Corpus');
    // The scoped lake's own count, not the all-lakes total.
    expect(screen.getByTestId('datalake-lake-picker-count')).toHaveTextContent('128');
  });

  it('renders a retry instead of an empty list when the read failed, and withholds the count', () => {
    const onRetry = vi.fn();
    // An empty list beside a "create your first lake" tree is exactly the lie #1645 removed.
    renderPicker({ isError: true, onRetry, lakes: undefined });
    openMenu();

    expect(screen.getByTestId('datalake-lake-picker-error')).toBeInTheDocument();
    expect(screen.queryByTestId('datalake-lake-picker-lake-count')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('datalake-lake-picker-retry-btn'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('withholds the count while loading, so it never reads as a confident zero', () => {
    renderPicker({ isLoading: true, lakes: undefined });
    openMenu();

    expect(screen.getByTestId('datalake-lake-picker-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('datalake-lake-picker-lake-count')).not.toBeInTheDocument();
  });

  it('marks a lake owned by someone else, so an admin cannot mistake it for their own', () => {
    renderPicker({
      lakes: [
        lake({ id: 'a', name: 'Mine' }),
        lake({ id: 'b', name: 'Theirs', isOwn: false, ownerDisplayName: 'Dana' }),
      ],
    });
    openMenu();

    expect(screen.queryByTestId('datalake-lake-picker-owner-icon-a')).not.toBeInTheDocument();
    expect(screen.getByTestId('datalake-lake-picker-owner-icon-b')).toBeInTheDocument();
  });

  it('only offers the filter box once the list is long enough to need one', () => {
    const few = Array.from({ length: 7 }, (_, i) => lake({ id: `l${i}`, name: `Lake ${i}` }));
    const { unmount } = renderPicker({ lakes: few });
    openMenu();
    expect(screen.queryByTestId('datalake-lake-picker-search')).not.toBeInTheDocument();
    unmount();

    renderPicker({ lakes: [...few, lake({ id: 'l7', name: 'Lake 7' })] });
    openMenu();
    expect(screen.getByTestId('datalake-lake-picker-search')).toBeInTheDocument();
  });

  it('offers Create and Discover from the lake list, the only home Discover has (#1943)', () => {
    const onCreate = vi.fn();
    const onDiscover = vi.fn();
    renderPicker({ lakes: [lake({ id: 'a', name: 'Mine' })], onCreate, onDiscover });

    openMenu();
    fireEvent.click(screen.getByTestId('datalake-lake-picker-discover-btn'));
    expect(onDiscover).toHaveBeenCalledTimes(1);

    openMenu();
    fireEvent.click(screen.getByTestId('datalake-lake-picker-create-btn'));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('hides Create and Discover when the caller may not use them', () => {
    renderPicker({ lakes: [lake({ id: 'a', name: 'Mine' })] });
    openMenu();

    expect(screen.queryByTestId('datalake-lake-picker-create-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('datalake-lake-picker-discover-btn')).not.toBeInTheDocument();
  });
});
