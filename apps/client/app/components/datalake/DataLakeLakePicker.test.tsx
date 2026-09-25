import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import menuItemClasses from '@mui/joy/MenuItem/menuItemClasses';
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
  selectedLakeIds: [] as string[],
  onChange: vi.fn(),
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

describe('DataLakeLakePicker - the no-lake scope', () => {
  const lakes = [lake({ id: 'a', name: 'Research Corpus' }), lake({ id: 'b', name: 'Design Docs' })];

  it('names the empty-but-deliberate scope as its own state, never as all lakes', () => {
    // These two are opposites - ground on everything vs ground on nothing - and both arrive here
    // as an empty selection. Showing the second as the first tells a user their chat is reading
    // the whole corpus when it is reading none of it.
    renderPicker({ lakes, selectedLakeIds: [], noLakeScope: true, totalFileCount: 170 });

    expect(screen.getByTestId('datalake-lake-picker-label')).toHaveTextContent('No data lakes');
    expect(screen.getByTestId('datalake-lake-picker-label')).not.toHaveTextContent('All data lakes');
  });

  it('prints no file count for it, since every lake file is out of scope', () => {
    // totalFileCount is the all-lakes figure; borrowing it here would put "170" beside a scope
    // that reaches nothing.
    renderPicker({ lakes, selectedLakeIds: [], noLakeScope: true, totalFileCount: 170 });

    expect(screen.queryByTestId('datalake-lake-picker-count')).not.toBeInTheDocument();
  });

  it('leaves the all-lakes row unselected, so the menu agrees with the trigger', () => {
    renderPicker({ lakes, selectedLakeIds: [], noLakeScope: true });
    openMenu();

    expect(screen.getByTestId('datalake-lake-picker-all')).not.toHaveClass(menuItemClasses.selected);
  });
});

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
    const onChange = vi.fn();
    renderPicker({ onChange, lakes: [lake({ id: 'a', name: 'Research Corpus' })] });

    openMenu();
    fireEvent.click(screen.getByTestId('datalake-lake-picker-lake-a'));
    expect(onChange).toHaveBeenCalledWith(['a']);

    fireEvent.click(screen.getByTestId('datalake-lake-picker-all'));
    // The empty set is the explicit all-lakes scope, not an absence of choice.
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('adds to the selection rather than replacing it, so a second lake joins the first', () => {
    const onChange = vi.fn();
    renderPicker({
      onChange,
      selectedLakeIds: ['a'],
      lakes: [lake({ id: 'a', name: 'Research Corpus' }), lake({ id: 'b', name: 'Design Docs' })],
    });

    openMenu();
    fireEvent.click(screen.getByTestId('datalake-lake-picker-lake-b'));
    expect(onChange).toHaveBeenCalledWith(['a', 'b']);
  });

  it('untoggles an already-selected lake, leaving the rest of the set intact', () => {
    const onChange = vi.fn();
    renderPicker({
      onChange,
      selectedLakeIds: ['a', 'b'],
      lakes: [lake({ id: 'a', name: 'Research Corpus' }), lake({ id: 'b', name: 'Design Docs' })],
    });

    openMenu();
    fireEvent.click(screen.getByTestId('datalake-lake-picker-lake-a'));
    expect(onChange).toHaveBeenCalledWith(['b']);
  });

  // Without the defaultMuiPrevented opt-out, MUI's useMenuItem dispatches `close` after the
  // row's own handler, so picking a second lake would mean reopening the menu for every one.
  // This is the test that fails if a Joy upgrade changes that opt-out.
  it('stays open while lakes are ticked, so a set can be built in one visit', () => {
    const onChange = vi.fn();
    renderPicker({
      onChange,
      lakes: [lake({ id: 'a', name: 'Research Corpus' }), lake({ id: 'b', name: 'Design Docs' })],
    });

    openMenu();
    fireEvent.click(screen.getByTestId('datalake-lake-picker-lake-a'));

    expect(screen.getByTestId('datalake-lake-picker-menu')).toBeInTheDocument();
    // Reachable without reopening - the row the user would tick next.
    fireEvent.click(screen.getByTestId('datalake-lake-picker-lake-b'));
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('checks the rows in the active set and only those', () => {
    renderPicker({
      selectedLakeIds: ['a'],
      lakes: [lake({ id: 'a', name: 'Research Corpus' }), lake({ id: 'b', name: 'Design Docs' })],
    });
    openMenu();

    expect(screen.getByTestId('datalake-lake-picker-check-a')).toBeChecked();
    expect(screen.getByTestId('datalake-lake-picker-check-b')).not.toBeChecked();
  });

  it('counts the lakes on the trigger past one, and withholds the file count it cannot source', () => {
    renderPicker({
      selectedLakeIds: ['a', 'b'],
      lakes: [lake({ id: 'a', name: 'Research Corpus' }), lake({ id: 'b', name: 'Design Docs' })],
      lakeFileCounts: { 'datalake:a': 128, 'datalake:b': 40 },
      totalFileCount: 170,
    });

    expect(screen.getByTestId('datalake-lake-picker-label')).toHaveTextContent('2 lakes');
    // NOT 168: summing per-lake counts double-counts a file that sits in both, and the all-lakes
    // total (170) describes a wider scope than the one selected. Neither is the answer, so the
    // control naming the scope prints no number at all.
    expect(screen.queryByTestId('datalake-lake-picker-count')).not.toBeInTheDocument();
  });

  it('still names the single lake rather than counting it, since the name is the useful fact', () => {
    renderPicker({
      selectedLakeIds: ['a'],
      lakes: [lake({ id: 'a', name: 'Research Corpus' }), lake({ id: 'b', name: 'Design Docs' })],
    });

    expect(screen.getByTestId('datalake-lake-picker-label')).toHaveTextContent('Research Corpus');
  });

  it('ignores a selected id whose lake the caller can no longer reach', () => {
    // An archived or revoked lake drops out of the list; honouring its id would leave the trigger
    // claiming a scope retrieval has already filtered away (see tagsForLakeIds).
    renderPicker({ selectedLakeIds: ['a', 'gone'], lakes: [lake({ id: 'a', name: 'Research Corpus' })] });

    expect(screen.getByTestId('datalake-lake-picker-label')).toHaveTextContent('Research Corpus');
  });

  it('names the scoped lake on the trigger, so the current scope reads without opening the menu', () => {
    renderPicker({
      selectedLakeIds: ['a'],
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

  it('names the zero state after the surface, not after the all-lakes row', () => {
    renderPicker({ lakes: [] });
    openMenu();

    // Reading allLakesLabel ("All data lakes") into the sentence produced the nonsense
    // "No all data lakes yet" on the first-run path.
    expect(screen.getByTestId('datalake-lake-picker-menu')).toHaveTextContent('No data lakes yet');
    expect(screen.getByTestId('datalake-lake-picker-menu')).not.toHaveTextContent('No all data lakes yet');
  });

  it('counts the filtered rows against the total while a filter narrows the list', () => {
    // 8 lakes is the threshold at which the filter box appears.
    const lakes = Array.from({ length: 8 }, (_, i) => lake({ id: `l${i}`, name: `Lake ${i}` }));
    renderPicker({ lakes });
    openMenu();

    expect(screen.getByTestId('datalake-lake-picker-lake-count')).toHaveTextContent('8 lakes');

    fireEvent.change(screen.getByTestId('datalake-lake-picker-search'), { target: { value: 'Lake 3' } });

    // A bare total under a single visible row reads as a stale count.
    expect(screen.getByTestId('datalake-lake-picker-lake-count')).toHaveTextContent('1 of 8 lakes');
  });

  // menuItemListSx reaches these rows through a `[role="menuitem"]` selector and marks the
  // selected one off `.Mui-selected`, so both are load-bearing: a Joy change to either would
  // silently drop the picker's rows back to Joy's neutral defaults.
  it('renders its rows as menuitems, the hook the shared row recipe styles them through', () => {
    renderPicker({
      lakes: [lake({ id: 'a', name: 'Research Corpus' }), lake({ id: 'b', name: 'Design Docs' })],
      selectedLakeIds: ['a'],
    });
    openMenu();

    const selected = screen.getByTestId('datalake-lake-picker-lake-a');
    expect(selected).toHaveAttribute('role', 'menuitem');
    expect(selected).toHaveClass(menuItemClasses.selected);
    expect(screen.getByTestId('datalake-lake-picker-lake-b')).not.toHaveClass(menuItemClasses.selected);
  });

  it('leaves the menu chrome off the row recipe, so only real rows pick up the row states', () => {
    const lakes = Array.from({ length: 8 }, (_, i) => lake({ id: `l${i}`, name: `Lake ${i}` }));
    renderPicker({ lakes });
    openMenu();

    // Joy gives a ListItem inside a Menu role="none"; the filter box and the count chip ride on
    // those, so the [role="menuitem"] rule never reaches them.
    const chrome = [
      screen.getByTestId('datalake-lake-picker-search').closest('li'),
      screen.getByTestId('datalake-lake-picker-lake-count').closest('li'),
    ];
    chrome.forEach(el => expect(el).toHaveAttribute('role', 'none'));
  });

  it('lets the trigger label inherit the button color, which the themed body-sm default does not', () => {
    renderPicker({ lakes: [lake({ id: 'a', name: 'Research Corpus' })], selectedLakeIds: ['a'] });

    // text.tertiary is the brand hue at 50% alpha in this theme - around 2.2:1 on the light
    // surface, which is not a contrast the primary scope label can afford.
    const label = screen.getByTestId('datalake-lake-picker-btn').querySelector('p');
    expect(label).toHaveTextContent('Research Corpus');
    // Resolves through the button's own variant color instead of the themed body-sm default.
    const labelColor = label ? getComputedStyle(label).color : '';
    expect(labelColor).toMatch(/variant-outlinedColor/i);
    expect(labelColor).not.toMatch(/text-tertiary/i);
  });
});
