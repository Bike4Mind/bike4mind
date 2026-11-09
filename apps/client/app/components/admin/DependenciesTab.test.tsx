import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import DependenciesTab from './DependenciesTab';
import {
  DEPENDENCY_CATEGORIES,
  PACKAGES,
  SHARED_DEPENDENCIES,
  type SharedDependency,
} from './content/dependenciesData';

const h = vi.hoisted(() => ({ shared: null as SharedDependency[] | null }));
vi.mock('./content/dependenciesData', async importOriginal => {
  const actual = await importOriginal<typeof import('./content/dependenciesData')>();
  return {
    ...actual,
    get SHARED_DEPENDENCIES() {
      return h.shared ?? actual.SHARED_DEPENDENCIES;
    },
  };
});

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderTab = () => render(<DependenciesTab />, { wrapper: TestWrapper });
const withKeyDeps = PACKAGES.find(pkg => pkg.keyDependencies.length > 0 && pkg.workspaceDependencies.length > 0)!;

describe('DependenciesTab', () => {
  afterEach(() => {
    h.shared = null;
  });

  it('opens with the page header', () => {
    renderTab();
    const header = screen.getByTestId('admin-page-header');
    expect(screen.getByTestId('admin-dependencies-tab').firstElementChild).toBe(header);
    expect(within(header).getByRole('heading', { level: 1 })).toHaveTextContent(/^Dependencies$/);
  });

  it('lists the categories as plain facts, not coloured chips', () => {
    renderTab();
    const categories = screen.getByTestId('dependencies-categories');
    expect(categories.querySelectorAll('.MuiChip-root')).toHaveLength(0);
    for (const category of DEPENDENCY_CATEGORIES) {
      expect(within(categories).getByText(category.name)).toBeInTheDocument();
      expect(within(categories).getByText(category.description)).toBeInTheDocument();
    }
  });

  it('shows every chip on the page in the neutral colour, and no emoji', () => {
    renderTab();
    fireEvent.click(within(screen.getByTestId(`dependencies-package-${withKeyDeps.name}`)).getByRole('button'));
    expect(screen.getByTestId(`dependencies-package-${withKeyDeps.name}-key`)).toBeVisible();
    expect(screen.getByTestId(`dependencies-package-${withKeyDeps.name}-workspace`)).toBeVisible();
    const chips = document.querySelectorAll('.MuiChip-root');
    expect(chips.length).toBeGreaterThan(PACKAGES.length);
    chips.forEach(chip => expect(chip).toHaveClass('MuiChip-colorNeutral'));
    expect(document.body.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('expands one package at a time', () => {
    renderTab();
    const [first, second] = PACKAGES;
    const toggle = (name: string) =>
      fireEvent.click(within(screen.getByTestId(`dependencies-package-${name}`)).getByRole('button'));
    toggle(first.name);
    expect(within(screen.getByTestId(`dependencies-package-${first.name}`)).getByRole('button')).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    toggle(second.name);
    expect(within(screen.getByTestId(`dependencies-package-${first.name}`)).getByRole('button')).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });

  it('renders the shared dependencies in a table that scrolls inside its own frame', () => {
    renderTab();
    const table = screen.getByTestId('dependencies-shared-table');
    expect(table.closest('[data-admin-table-frame]')).toHaveStyle({ overflowX: 'auto' });
    for (const dep of SHARED_DEPENDENCIES) {
      const row = within(table).getByTestId(`dependencies-shared-${dep.name}`);
      expect(row).toHaveTextContent(dep.version);
      expect(row).toHaveTextContent(dep.category);
    }
  });

  it('lists every shared dependency with no pager, even past one page of 25', () => {
    h.shared = Array.from({ length: 26 }, (_, index) => ({
      name: `dep-${index}`,
      version: '1.0.0',
      usedByCount: index,
      category: 'Utilities',
    }));
    renderTab();
    const table = screen.getByTestId('dependencies-shared-table');
    expect(within(table).getByTestId('dependencies-shared-dep-25')).toBeInTheDocument();
    expect(within(table).queryByTestId('admin-table-footer')).toBeNull();
  });
});
