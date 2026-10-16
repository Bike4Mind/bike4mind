import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import IntegrationsPage from './index';

const router = vi.hoisted(() => ({ search: {} as { tab?: string; source?: string }, navigate: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => router.navigate }));
vi.mock('@client/app/router', () => ({ integrationsRoute: { useSearch: () => router.search } }));
vi.mock('@client/app/components/common/PageFrame', () => ({
  default: ({ children, testId }: { children: React.ReactNode; testId: string }) => (
    <div data-testid={testId}>{children}</div>
  ),
}));
vi.mock('@client/app/hooks/useMobileHeader', () => ({ useMobileHeader: vi.fn() }));
vi.mock('@client/app/components/integrations/IntegrationsGallery', () => ({
  default: ({ source }: { source: string }) => <div data-testid="gallery-stub">{source}</div>,
}));
vi.mock('@client/app/components/ProfileModal/ApiTabContent', () => ({
  default: () => <div data-testid="api-keys-stub" />,
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const renderPage = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <IntegrationsPage />
    </CssVarsProvider>
  );

describe('IntegrationsPage tabs', () => {
  beforeEach(() => {
    router.search = {};
    router.navigate.mockClear();
  });

  it('is headed Connections and opens on the Integrations tab by default', () => {
    renderPage();
    expect(screen.getByRole('heading', { name: 'Connections' })).toBeInTheDocument();
    expect(screen.getByTestId('connections-tab-integrations')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('gallery-stub')).toHaveTextContent('direct');
    expect(screen.queryByTestId('api-keys-stub')).not.toBeInTheDocument();
  });

  it('selects the API Keys tab for ?tab=api-keys', () => {
    router.search = { tab: 'api-keys' };
    renderPage();
    expect(screen.getByTestId('connections-tab-api-keys')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('api-keys-stub')).toBeInTheDocument();
    expect(screen.queryByTestId('gallery-stub')).not.toBeInTheDocument();
  });

  it('writes the chosen tab to the URL when switching', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('connections-tab-api-keys'));
    expect(router.navigate).toHaveBeenCalledWith({ to: '/integrations', search: { tab: 'api-keys' }, replace: true });
  });

  it('drops source from the URL but keeps the tab, and still passes source to the gallery', () => {
    router.search = { source: 'profile_menu' };
    const first = renderPage();
    expect(screen.getByTestId('gallery-stub')).toHaveTextContent('profile_menu');
    expect(router.navigate).toHaveBeenCalledWith({ to: '/integrations', search: {}, replace: true });
    first.unmount();

    router.navigate.mockClear();
    router.search = { source: 'profile_menu', tab: 'api-keys' };
    renderPage();
    expect(router.navigate).toHaveBeenCalledWith({ to: '/integrations', search: { tab: 'api-keys' }, replace: true });
  });
});
