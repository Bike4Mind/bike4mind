import React from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import ApiCookbookTab from './ApiCookbookTab';
import { COOKBOOK_RECIPES } from './content/apiCookbookContent';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderTab = () => render(<ApiCookbookTab />, { wrapper: TestWrapper });
const [first] = COOKBOOK_RECIPES;

describe('ApiCookbookTab', () => {
  it('opens with the page header and the recipe count', () => {
    renderTab();
    const header = screen.getByTestId('admin-page-header');
    expect(screen.getByTestId('admin-api-cookbook-tab').firstElementChild).toBe(header);
    expect(within(header).getByRole('heading', { level: 1 })).toHaveTextContent(
      `API cookbook (${COOKBOOK_RECIPES.length})`
    );
  });

  it('lists every recipe as a row of one table, with no pager', () => {
    renderTab();
    const table = screen.getByTestId('api-cookbook-table');
    for (const recipe of COOKBOOK_RECIPES) {
      const row = within(table).getByTestId(`api-cookbook-recipe-${recipe.id}`);
      expect(row).toHaveTextContent(recipe.title);
      expect(row).toHaveTextContent(recipe.description);
    }
    expect(within(table).getAllByRole('row')).toHaveLength(COOKBOOK_RECIPES.length + 1);
    expect(screen.queryByTestId('admin-table-footer')).toBeNull();
  });

  it('shows difficulty as a neutral chip with a sentence-case label, and no emoji', () => {
    renderTab();
    for (const recipe of COOKBOOK_RECIPES) {
      const chip = screen.getByTestId(`api-cookbook-${recipe.id}-difficulty`);
      expect(chip).toHaveClass('MuiChip-colorNeutral');
      expect(chip.textContent).toMatch(/^(Beginner|Intermediate|Advanced)$/);
    }
    expect(document.body.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('opens a recipe from its row and goes back to the list', () => {
    renderTab();
    fireEvent.click(within(screen.getByTestId(`api-cookbook-recipe-${first.id}`)).getByText(first.title));
    const detail = screen.getByTestId('api-cookbook-recipe-detail');
    expect(within(detail).getByRole('heading', { level: 3, name: first.title })).toBeInTheDocument();
    expect(screen.getByTestId(`api-cookbook-${first.id}-difficulty`)).toHaveClass('MuiChip-colorNeutral');
    expect(screen.queryByTestId('api-cookbook-table')).toBeNull();
    expect(screen.getByTestId('admin-api-cookbook-tab').firstElementChild).toBe(
      screen.getByTestId('admin-page-header')
    );

    fireEvent.click(screen.getByTestId('api-cookbook-back-btn'));
    expect(screen.getByTestId('api-cookbook-table')).toBeInTheDocument();
    expect(screen.queryByTestId('api-cookbook-recipe-detail')).toBeNull();
  });

  it('opens a recipe with the keyboard', () => {
    renderTab();
    fireEvent.keyDown(screen.getByTestId(`api-cookbook-recipe-${first.id}`), { key: 'Enter' });
    expect(screen.getByTestId('api-cookbook-recipe-detail')).toBeInTheDocument();
  });
});
