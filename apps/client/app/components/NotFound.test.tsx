/**
 * Branded 404 page. Asserts the page + CTA render and that the CTA
 * routes home via Tanstack Router navigation (not next/*).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const navigateMock = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}));
vi.mock('../hooks/useGetLogo', () => ({ default: () => '' }));
vi.mock('next/image', () => ({
  default: (props: Record<string, unknown>) => <img alt={props.alt as string} />,
}));

import NotFound from './NotFound';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('NotFound', () => {
  beforeEach(() => {
    navigateMock.mockClear();
  });

  it('renders the branded 404 page and CTA', () => {
    render(
      <TestWrapper>
        <NotFound />
      </TestWrapper>
    );
    expect(screen.getByTestId('notfound-page')).toBeInTheDocument();
    expect(screen.getByTestId('notfound-home-btn')).toBeInTheDocument();
  });

  it('CTA navigates home via Tanstack Router', () => {
    render(
      <TestWrapper>
        <NotFound />
      </TestWrapper>
    );
    fireEvent.click(screen.getByTestId('notfound-home-btn'));
    expect(navigateMock).toHaveBeenCalledWith({ to: '/' });
  });
});
