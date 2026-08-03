import { getThemeConfig } from '@client/app/utils/themes';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import PaginationControls from './PaginationControls';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const baseProps = {
  currentPage: 2,
  totalPages: 4,
  onPageChange: vi.fn(),
  currentLimit: 10,
  onLimitChange: vi.fn(),
  totalUsers: 37,
  pageLimitOptions: [5, 10, 20],
};

describe('PaginationControls', () => {
  it('shows the page size picker and total count in the full variant', () => {
    render(<PaginationControls {...baseProps} variant="full" />, { wrapper: TestWrapper });

    expect(screen.getByText('Page 2 of 4')).toBeInTheDocument();
    expect(screen.getByText('37 users')).toBeInTheDocument();
    expect(screen.getByTestId('admin-page-size-select')).toBeInTheDocument();
  });

  it('keeps the page size picker but drops the total count in the compact variant', () => {
    render(<PaginationControls {...baseProps} variant="compact" />, { wrapper: TestWrapper });

    expect(screen.getByText('2 of 4')).toBeInTheDocument();
    // Compact is the only pager on phones, so page size has to stay reachable here.
    expect(screen.getByTestId('admin-page-size-select')).toBeInTheDocument();
    expect(screen.queryByText('37 users')).not.toBeInTheDocument();
  });

  it('shows the active page size in both variants', () => {
    const { unmount } = render(<PaginationControls {...baseProps} variant="compact" />, { wrapper: TestWrapper });
    expect(screen.getByTestId('admin-page-size-select')).toHaveTextContent('10 / page');
    unmount();

    render(<PaginationControls {...baseProps} variant="full" />, { wrapper: TestWrapper });
    expect(screen.getByTestId('admin-page-size-select')).toHaveTextContent('10 / page');
  });

  it('disables the pager at both ends of the range', () => {
    const { unmount } = render(<PaginationControls {...baseProps} currentPage={1} variant="compact" />, {
      wrapper: TestWrapper,
    });
    expect(screen.getByLabelText('Previous page')).toBeDisabled();
    expect(screen.getByLabelText('Next page')).toBeEnabled();
    unmount();

    render(<PaginationControls {...baseProps} currentPage={4} variant="compact" />, { wrapper: TestWrapper });
    expect(screen.getByLabelText('Next page')).toBeDisabled();
  });

  it('reports page changes', async () => {
    const onPageChange = vi.fn();
    render(<PaginationControls {...baseProps} onPageChange={onPageChange} variant="compact" />, {
      wrapper: TestWrapper,
    });

    await userEvent.click(screen.getByLabelText('Next page'));

    expect(onPageChange).toHaveBeenCalledWith(3);
  });
});
