import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import ApiReferenceTab from './ApiReferenceTab';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('ApiReferenceTab', () => {
  it('links to the interactive docs at /api/v1/docs in a new tab', () => {
    render(<ApiReferenceTab />, { wrapper: TestWrapper });
    const link = screen.getByTestId('api-reference-open-docs-btn');
    expect(link).toHaveAttribute('href', '/api/v1/docs');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('offers a download of the raw OpenAPI spec at /api/v1/openapi.json', () => {
    render(<ApiReferenceTab />, { wrapper: TestWrapper });
    const link = screen.getByTestId('api-reference-download-spec-btn');
    expect(link).toHaveAttribute('href', '/api/v1/openapi.json');
    expect(link).toHaveAttribute('download', 'openapi.json');
  });

  it('warns that the hand-written reference may lag the code, pointing at the generated docs', () => {
    render(<ApiReferenceTab />, { wrapper: TestWrapper });
    const banner = screen.getByTestId('api-reference-drift-banner');
    expect(banner).toHaveTextContent(/hand-maintained and may lag/i);
    expect(banner.querySelector('a')).toHaveAttribute('href', '/api/v1/docs');
  });
});
