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
const gallery = vi.hoisted(() => ({ mounts: [] as string[] }));
vi.mock('@client/app/components/integrations/IntegrationsGallery', () => ({
  // Models the real gallery: one page view per mount, from the source it first sees.
  default: function GalleryStub({ source }: { source?: string }) {
    const seen = React.useRef(false);
    React.useEffect(() => {
      if (seen.current) return;
      seen.current = true;
      gallery.mounts.push(source ?? 'direct');
    }, [source]);
    return <div data-testid="gallery-stub">{source}</div>;
  },
}));
vi.mock('@client/app/components/ProfileModal/ApiTabContent', () => ({
  default: () => <div data-testid="api-keys-stub" />,
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const pageElement = () => (
  <CssVarsProvider theme={appTheme}>
    <IntegrationsPage />
  </CssVarsProvider>
);
const renderPage = () => render(pageElement());

describe('IntegrationsPage tabs', () => {
  beforeEach(() => {
    router.search = {};
    router.navigate.mockClear();
    gallery.mounts = [];
  });

  it('is headed Connections and opens on the Integrations tab by default', () => {
    renderPage();
    expect(screen.getByRole('heading', { name: 'Connections' })).toBeInTheDocument();
    expect(screen.getByTestId('connections-tab-integrations')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('gallery-stub')).toHaveTextContent('direct');
    expect(screen.queryByTestId('api-keys-stub')).not.toBeInTheDocument();
  });

  it('selects the API Keys tab for ?tab=api-keys without mounting the gallery', () => {
    router.search = { tab: 'api-keys' };
    renderPage();
    expect(screen.getByTestId('connections-tab-api-keys')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('api-keys-stub')).toBeInTheDocument();
    expect(screen.queryByTestId('gallery-stub')).not.toBeInTheDocument();
    expect(gallery.mounts).toEqual([]);
  });

  it('keeps the gallery mounted, hidden, once the Integrations tab has been shown', () => {
    const view = renderPage();
    router.search = { tab: 'api-keys' };
    view.rerender(pageElement());
    expect(screen.getByTestId('gallery-stub').closest('[role="tabpanel"]')).toHaveAttribute('hidden');
    router.search = { tab: 'integrations' };
    view.rerender(pageElement());
    expect(gallery.mounts).toEqual(['direct']);
  });

  it('records one view under StrictMode', () => {
    router.search = { source: 'profile_menu' };
    render(<React.StrictMode>{pageElement()}</React.StrictMode>);
    expect(gallery.mounts).toEqual(['profile_menu']);
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

  it('counts no gallery view for an API Keys visit, and one with the entry point if Integrations is then opened', () => {
    router.search = { tab: 'api-keys', source: 'profile_menu' };
    const view = renderPage();
    expect(gallery.mounts).toEqual([]);

    // The URL has lost ?source= by now; the entry point the page first saw still reaches the gallery.
    router.search = { tab: 'integrations' };
    view.rerender(pageElement());
    expect(gallery.mounts).toEqual(['profile_menu']);

    router.search = { tab: 'api-keys' };
    view.rerender(pageElement());
    router.search = { tab: 'integrations' };
    view.rerender(pageElement());
    expect(gallery.mounts).toEqual(['profile_menu']);
  });
});
