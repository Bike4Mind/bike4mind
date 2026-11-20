import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { DESKTOP_RELEASE_QUERY_KEY } from '@client/app/hooks/data/desktopRelease';
import { DESKTOP_INSTALL_COMMAND, DESKTOP_RELEASES_PAGE_URL } from '@client/app/utils/desktopReleases';
import DesktopDownloadPage from './desktop';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

const BASE = 'https://github.com/Bike4Mind/desktop-releases';
const DMG_URL = `${BASE}/releases/download/desktop-v0.42.0/Bike4Mind-0.42.0-arm64.dmg`;
const APPIMAGE_URL = `${BASE}/releases/download/desktop-v0.42.0/Bike4Mind-0.42.0-x64.AppImage`;
const EXE_URL = `${BASE}/releases/download/desktop-v0.42.0/Bike4Mind-0.42.0-setup.exe`;
const RELEASE = {
  tag_name: 'desktop-v0.42.0',
  html_url: `${BASE}/releases/tag/desktop-v0.42.0`,
  assets: [
    { name: 'Bike4Mind-0.42.0-arm64.dmg', browser_download_url: DMG_URL },
    { name: 'Bike4Mind-0.42.0-x64.AppImage', browser_download_url: APPIMAGE_URL },
    { name: 'Bike4Mind-0.42.0-setup.exe', browser_download_url: EXE_URL },
  ],
};

const UA = {
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  linux: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
  windows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
};

const appTheme = extendTheme({ ...getThemeConfig() });

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <CssVarsProvider theme={appTheme}>
          <DesktopDownloadPage />
        </CssVarsProvider>
      </QueryClientProvider>
    ),
  };
}

function setUserAgent(userAgent: string, userAgentData?: unknown) {
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(userAgent);
  Object.defineProperty(window.navigator, 'userAgentData', { value: userAgentData, configurable: true });
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockResolvedValue({ ok: true, json: async () => RELEASE });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fetchMock.mockReset();
});

describe('DesktopDownloadPage', () => {
  it('leads an Apple Silicon Mac with the install command, then the dmg and the Gatekeeper note', async () => {
    setUserAgent(UA.mac, {
      platform: 'macOS',
      getHighEntropyValues: async () => ({ architecture: 'arm', bitness: '64' }),
    });
    renderPage();

    const primary = screen.getByTestId('desktop-download-primary');
    await waitFor(() =>
      expect(within(primary).getByTestId('desktop-download-dmg-link')).toHaveAttribute('href', DMG_URL)
    );
    expect(primary).toHaveAttribute('data-platform', 'mac-arm64');
    expect(within(primary).getByText('macOS (Apple Silicon)')).toBeInTheDocument();
    expect(within(primary).getByTestId('desktop-download-command')).toHaveTextContent(DESKTOP_INSTALL_COMMAND);
    expect(within(primary).getByTestId('desktop-download-gatekeeper-note')).toHaveTextContent('Open Anyway');
    expect(within(primary).getByRole('img', { name: /desktop app/ })).toBeInTheDocument();
    expect(within(primary).queryByTestId('desktop-download-ambiguous-note')).not.toBeInTheDocument();
    expect(screen.getByTestId('desktop-download-version')).toHaveTextContent('Version 0.42.0');
    expect(screen.getByTestId('desktop-download-platform-mac-intel')).toHaveTextContent('Paused');
  });

  it('offers a Mac of unknown chip the Apple Silicon build and says plainly that Intel is paused', async () => {
    setUserAgent(UA.mac);
    renderPage();

    const primary = screen.getByTestId('desktop-download-primary');
    expect(primary).toHaveAttribute('data-platform', 'mac-arm64');
    expect(within(primary).getByText('macOS')).toBeInTheDocument();
    expect(within(primary).getByTestId('desktop-download-ambiguous-note')).toHaveTextContent(
      'Intel Macs are temporarily paused'
    );
    expect(within(primary).getByTestId('desktop-download-command')).toBeInTheDocument();
    expect(screen.getByTestId('desktop-download-platform-mac-intel')).toHaveTextContent('Paused');
    await waitFor(() =>
      expect(within(primary).getByTestId('desktop-download-dmg-link')).toHaveAttribute('href', DMG_URL)
    );
  });

  it('leads Linux with the install command and the AppImage, without the macOS note', async () => {
    setUserAgent(UA.linux);
    renderPage();

    const primary = screen.getByTestId('desktop-download-primary');
    expect(primary).toHaveAttribute('data-platform', 'linux-x64');
    expect(within(primary).getByTestId('desktop-download-command')).toHaveTextContent(DESKTOP_INSTALL_COMMAND);
    await waitFor(() =>
      expect(within(primary).getByTestId('desktop-download-appimage-link')).toHaveAttribute('href', APPIMAGE_URL)
    );
    expect(screen.queryByTestId('desktop-download-gatekeeper-note')).not.toBeInTheDocument();
    expect(screen.getByTestId('desktop-download-platform-mac-arm64')).toBeInTheDocument();
  });

  it('leads Windows with the setup.exe and the SmartScreen note, without an install command', async () => {
    setUserAgent(UA.windows);
    renderPage();

    const primary = screen.getByTestId('desktop-download-primary');
    expect(primary).toHaveAttribute('data-platform', 'windows');
    expect(within(primary).getByText('Windows (x64 and ARM)')).toBeInTheDocument();
    await waitFor(() =>
      expect(within(primary).getByTestId('desktop-download-exe-link')).toHaveAttribute('href', EXE_URL)
    );
    expect(within(primary).getByTestId('desktop-download-smartscreen-note')).toHaveTextContent('Run anyway');
    expect(within(primary).queryByTestId('desktop-download-command')).not.toBeInTheDocument();
    expect(within(primary).queryByTestId('desktop-download-unavailable')).not.toBeInTheDocument();
    expect(screen.queryByTestId('desktop-download-gatekeeper-note')).not.toBeInTheDocument();
    expect(screen.queryByTestId('desktop-download-platform-windows')).not.toBeInTheDocument();
  });

  it('lists Windows with a download link on the other platforms of a Mac', async () => {
    setUserAgent(UA.mac);
    renderPage();

    const row = screen.getByTestId('desktop-download-platform-windows');
    expect(row).toHaveTextContent('Windows (x64 and ARM)');
    expect(row).not.toHaveTextContent('Not available yet');
    await waitFor(() => expect(within(row).getByRole('link')).toHaveAttribute('href', EXE_URL));
  });

  it('links Windows to the release page when the release has no exe asset', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ...RELEASE, assets: RELEASE.assets.filter(asset => !asset.name.endsWith('.exe')) }),
    });
    setUserAgent(UA.windows);
    renderPage();

    await waitFor(() => expect(screen.getByTestId('desktop-download-version')).toHaveTextContent('Version 0.42.0'));
    const exe = screen.getByTestId('desktop-download-exe-link');
    expect(exe).toHaveAttribute('href', RELEASE.html_url);
    expect(exe).toHaveTextContent('Get the .exe on GitHub');
  });

  it('falls back to the releases page for Windows when the API is unreachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    setUserAgent(UA.windows);
    const { queryClient } = renderPage();

    await waitFor(() => expect(queryClient.getQueryState(DESKTOP_RELEASE_QUERY_KEY)?.status).toBe('error'));
    const exe = screen.getByTestId('desktop-download-exe-link');
    expect(exe).toHaveAttribute('href', DESKTOP_RELEASES_PAGE_URL);
    expect(exe).toHaveTextContent('Get the .exe on GitHub');
  });

  it.each([
    ['a rate limit', () => fetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({}) })],
    ['a network failure', () => fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))],
  ])('still works on %s, using the stable latest-release links', async (_name, failFetch) => {
    failFetch();
    setUserAgent(UA.mac, {
      platform: 'macOS',
      getHighEntropyValues: async () => ({ architecture: 'arm', bitness: '64' }),
    });
    const { queryClient } = renderPage();

    await waitFor(() => expect(queryClient.getQueryState(DESKTOP_RELEASE_QUERY_KEY)?.status).toBe('error'));
    const primary = screen.getByTestId('desktop-download-primary');
    expect(within(primary).getByTestId('desktop-download-command')).toHaveTextContent(DESKTOP_INSTALL_COMMAND);
    const dmg = within(primary).getByTestId('desktop-download-dmg-link');
    expect(dmg).toHaveAttribute('href', DESKTOP_RELEASES_PAGE_URL);
    expect(dmg).toHaveTextContent('Get the .dmg on GitHub');
    expect(screen.getByTestId('desktop-download-version')).toHaveTextContent('Latest version');
    expect(screen.getByTestId('desktop-download-release-notes-link')).toHaveAttribute(
      'href',
      DESKTOP_RELEASES_PAGE_URL
    );
  });

  it('names the tab after the page instead of keeping the previous page title', () => {
    document.title = 'New Notebook | Notebook';
    setUserAgent(UA.linux);
    renderPage();
    expect(document.title).toBe('Bike4Mind desktop app');
  });

  it('never sends credentials to the GitHub API', async () => {
    setUserAgent(UA.linux);
    renderPage();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/Bike4Mind/desktop-releases/releases/latest');
    expect(init).toMatchObject({ credentials: 'omit' });
    expect(init.headers).not.toHaveProperty('Authorization');
  });
});
