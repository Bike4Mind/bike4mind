import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { AdminCommandPalette } from './AdminCommandPalette';
import { FilterBar } from './FilterBar';

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
const theme = extendTheme({ ...getThemeConfig() });

describe('FilterBar keyboard search', () => {
  it('focuses the real shared search with / and forwards its edits', () => {
    const onChange = vi.fn();
    render(
      <CssVarsProvider theme={theme}>
        <div data-admin-surface>
          <AdminCommandPalette />
          <FilterBar state={{ query: '', filters: {}, view: '' }} onChange={onChange} />
        </div>
      </CssVarsProvider>
    );
    fireEvent.keyDown(document.body, { key: '/' });
    const input = screen.getByTestId('admin-filter-search-input');
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: 'example' } });
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ query: 'example', view: '' });
  });
});
