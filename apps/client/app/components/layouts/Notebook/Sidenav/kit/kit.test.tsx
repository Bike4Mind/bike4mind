import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ReactNode } from 'react';
import { NavIcon, SidenavNavRow, SidenavNavStack, SidenavPinned, SidenavSearchBar, SidenavSection } from '.';

const appTheme = extendTheme({ ...getThemeConfig() });
const wrap = (node: ReactNode) => render(<CssVarsProvider theme={appTheme}>{node}</CssVarsProvider>);

describe('SidenavNavRow', () => {
  it('is a keyboard button that fires on Enter and Space, passing the event', () => {
    const onClick = vi.fn();
    wrap(<SidenavNavRow data-testid="row" icon={<NavIcon>i</NavIcon>} label="Files" onClick={onClick} />);
    const row = screen.getByTestId('row');
    expect(row).toHaveAttribute('role', 'button');
    expect(row).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(row, { key: 'Enter' });
    fireEvent.keyDown(row, { key: ' ' });
    fireEvent.click(row);
    expect(onClick).toHaveBeenCalledTimes(3);
    expect(onClick.mock.calls[0][0]).toHaveProperty('isTrusted');
  });

  it('marks the active row as the current page', () => {
    wrap(<SidenavNavRow data-testid="row" icon={null} label="Files" active />);
    expect(screen.getByTestId('row')).toHaveAttribute('aria-current', 'page');
  });

  it('ignores mouse and keyboard while disabled', () => {
    const onClick = vi.fn();
    wrap(<SidenavNavRow data-testid="row" icon={null} label="New" disabled onClick={onClick} />);
    const row = screen.getByTestId('row');
    expect(row).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(row);
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(onClick).not.toHaveBeenCalled();
  });

  it('keeps a disabled link row from following its href', () => {
    wrap(<SidenavNavRow data-testid="row" component="a" href="/new" icon={null} label="New" disabled />);
    expect(fireEvent.click(screen.getByTestId('row'))).toBe(false);
  });

  it('renders as the given element without forcing a button role', () => {
    wrap(<SidenavNavRow data-testid="row" component="a" href="/new" icon={null} label="Back" />);
    const row = screen.getByTestId('row');
    expect(row.tagName).toBe('A');
    expect(row).toHaveAttribute('href', '/new');
    expect(row).not.toHaveAttribute('role');
  });

  it('draws the trailing node after the label', () => {
    wrap(<SidenavNavRow data-testid="row" icon={null} label="Gears" trailing={<span data-testid="tag" />} />);
    expect(screen.getByTestId('row').lastElementChild).toContainElement(screen.getByTestId('tag'));
  });

  it('pulls the tag into the row padding, and drops its slot when the tag renders nothing', () => {
    const NoTag = () => null;
    wrap(
      <>
        <SidenavNavRow data-testid="tagged" icon={null} label="Gears" trailing={<span>Start here</span>} />
        <SidenavNavRow data-testid="untagged" icon={null} label="Bob" trailing={<NoTag />} />
      </>
    );
    const tagged = screen.getByTestId('tagged').lastElementChild as HTMLElement;
    expect(getComputedStyle(tagged).marginRight).toBe('-8px');
    expect(getComputedStyle(tagged).display).toBe('flex');
    expect(getComputedStyle(screen.getByTestId('untagged').lastElementChild as HTMLElement).display).toBe('none');
  });
});

describe('kit blocks', () => {
  it('carry the host class names so all rails share one DOM shape', () => {
    wrap(
      <>
        <SidenavPinned data-testid="pinned" />
        <SidenavSection data-testid="section" />
        <SidenavNavStack data-testid="stack" />
        <SidenavSearchBar data-testid="search" top={78}>
          <input />
        </SidenavSearchBar>
      </>
    );
    expect(screen.getByTestId('pinned')).toHaveClass('notebook-sidenav-pinned');
    expect(screen.getByTestId('section')).toHaveClass('notebook-sidenav-container');
    expect(screen.getByTestId('stack')).toHaveClass('notebook-sidenav-nav');
    expect(screen.getByTestId('search')).toHaveClass('notebook-sidenav-search-container');
    expect(screen.getByTestId('search').querySelector('hr, [role="separator"]')).not.toBeNull();
  });

  it('forwards the pinned ref for height measurement', () => {
    const ref = { current: null as HTMLDivElement | null };
    wrap(<SidenavPinned ref={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLDivElement);
  });
});
