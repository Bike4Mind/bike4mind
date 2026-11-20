import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { ApiKeyScope } from '@bike4mind/common';
import ApiReferenceTab from './ApiReferenceTab';

const h = vi.hoisted(() => ({ hasOptiAccess: false }));
vi.mock('@client/app/hooks/data/opti', () => ({ useOptiAccess: () => h.hasOptiAccess }));
vi.mock('@client/app/hooks/data/productScopeAccess', () => ({
  useOverwatchAccess: () => true,
  useHearthEnabled: () => true,
  useApiKeyScopeEntitlements: () => ({ bypass: false, entitlements: new Set<string>() }),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('ApiReferenceTab', () => {
  beforeEach(() => {
    h.hasOptiAccess = false;
  });

  const showHandWritten = () => fireEvent.click(screen.getByTestId('api-reference-view-full'));

  it('opens with the page header, the actions in its slot and no emoji', () => {
    render(<ApiReferenceTab />, { wrapper: TestWrapper });
    const header = screen.getByTestId('admin-page-header');
    expect(screen.getByTestId('admin-api-reference-tab').firstElementChild).toBe(header);
    expect(within(header).getByRole('heading', { level: 1 })).toHaveTextContent(/^API reference$/);
    expect(within(header).getByTestId('api-reference-open-docs-btn')).toHaveTextContent('Open in new tab');
    expect(within(header).getByTestId('api-reference-download-spec-btn')).toHaveTextContent('Download OpenAPI spec');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(document.body.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it.each([
    ['full', /API Reference$/],
    ['quickstart', /API Quickstart$/],
  ])('keeps the page title as the only h1 in the %s view', (view, markdownTitle) => {
    render(<ApiReferenceTab />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByTestId(`api-reference-view-${view}`));
    const [h1] = screen.getAllByRole('heading', { level: 1 });
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(h1).toHaveTextContent(/^API reference$/);
    expect(screen.getAllByRole('heading', { level: 2 })[0]).toHaveTextContent(markdownTitle);
  });

  it('switches views with the toolkit segmented control', () => {
    render(<ApiReferenceTab />, { wrapper: TestWrapper });
    const group = screen.getByRole('group', { name: 'Reference view' });
    expect(group).toHaveAttribute('data-testid', 'api-reference-view');
    expect(
      within(group)
        .getAllByRole('button')
        .map(button => button.textContent)
    ).toEqual(['Interactive docs', 'Auth and unmigrated endpoints', 'Claude Code quickstart']);
  });

  it('embeds the generated docs by default, without the drift banner', () => {
    render(<ApiReferenceTab />, { wrapper: TestWrapper });
    const frame = screen.getByTestId('api-reference-docs-iframe');
    expect(frame).toHaveAttribute('src', '/api/v1/docs');
    expect(frame).toHaveAttribute('title', 'API reference');
    expect(screen.queryByTestId('api-reference-drift-banner')).toBeNull();
  });

  it('marks the active view toggle as pressed', () => {
    render(<ApiReferenceTab />, { wrapper: TestWrapper });
    expect(screen.getByTestId('api-reference-view-docs')).toHaveAttribute('aria-pressed', 'true');
    showHandWritten();
    expect(screen.getByTestId('api-reference-view-full')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('api-reference-view-docs')).toHaveAttribute('aria-pressed', 'false');
  });

  it('switches to the quickstart, unmounting the docs frame', () => {
    render(<ApiReferenceTab />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByTestId('api-reference-view-quickstart'));
    expect(screen.queryByTestId('api-reference-docs-iframe')).toBeNull();
    expect(screen.queryByTestId('api-reference-drift-banner')).toBeNull();
  });

  it('lists the premium scopes in the scopes table only with Opti access', () => {
    const { unmount } = render(<ApiReferenceTab />, { wrapper: TestWrapper });
    showHandWritten();
    expect(screen.queryByText(ApiKeyScope.OPTIHASHI_READ)).toBeNull();
    unmount();

    h.hasOptiAccess = true;
    render(<ApiReferenceTab />, { wrapper: TestWrapper });
    showHandWritten();
    expect(screen.getByText(ApiKeyScope.OPTIHASHI_READ)).toBeInTheDocument();
  });

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
    showHandWritten();
    const banner = screen.getByTestId('api-reference-drift-banner');
    expect(banner).toHaveTextContent(/hand-maintained and may lag/i);
    expect(screen.getByTestId('api-reference-drift-docs-link')).toHaveAttribute('href', '/api/v1/docs');
  });
});
