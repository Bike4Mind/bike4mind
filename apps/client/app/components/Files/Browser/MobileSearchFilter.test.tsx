import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { MobileSearchFilter } from './MobileSearchFilter';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const baseProps = {
  searchValue: '',
  onSearchChange: vi.fn(),
  sortField: 'createdAt' as const,
  sortDirection: 'desc' as const,
  onSortChange: vi.fn(),
};

describe('MobileSearchFilter generated toggle', () => {
  it('turns the filter on when clicked while inactive', () => {
    const onGeneratedChange = vi.fn();
    render(<MobileSearchFilter {...baseProps} generatedOnly={false} onGeneratedChange={onGeneratedChange} />, {
      wrapper: Wrapper,
    });
    const button = screen.getByTestId('file-browser-generated-filter-btn');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button);
    expect(onGeneratedChange).toHaveBeenCalledWith(true);
  });

  it('is pressed while active and turns the filter off when clicked', () => {
    const onGeneratedChange = vi.fn();
    render(<MobileSearchFilter {...baseProps} generatedOnly onGeneratedChange={onGeneratedChange} />, {
      wrapper: Wrapper,
    });
    const button = screen.getByTestId('file-browser-generated-filter-btn');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(button);
    expect(onGeneratedChange).toHaveBeenCalledWith(false);
  });

  it('does not render the toggle without onGeneratedChange', () => {
    render(<MobileSearchFilter {...baseProps} />, { wrapper: Wrapper });
    expect(screen.queryByTestId('file-browser-generated-filter-btn')).toBeNull();
  });
});
