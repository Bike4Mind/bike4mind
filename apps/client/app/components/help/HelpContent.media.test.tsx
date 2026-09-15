import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import ReactMarkdown from 'react-markdown';
import type { HelpAccessLevel } from '@bike4mind/scripts/help/types';

vi.mock('@client/app/hooks/useHelpContent');
vi.mock('./HelpFeedbackWidget', () => ({ default: () => null }));

import { useHelpContent } from '@client/app/hooks/useHelpContent';
import { useHelpPanel } from '@client/app/hooks/useHelpPanel';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import HelpContent, {
  remarkPlugins,
  rehypePlugins,
  markdownComponents,
  resolveHelpMediaSrc,
  HelpArticleFilePathContext,
} from './HelpContent';

/**
 * Media embedding in help articles: GIFs/images render as lazy <img>, and
 * .webm/.mp4 demo videos (authored with the same ![alt](path) image syntax)
 * render as lazy gif-style <video>. Rendered through the exact production
 * pipeline exported by HelpContent.tsx.
 */

const renderMarkdown = (md: string, filePath = 'features/projects.md', accessLevel?: HelpAccessLevel) =>
  render(
    <HelpArticleFilePathContext.Provider value={{ filePath, accessLevel }}>
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={markdownComponents}>
        {md}
      </ReactMarkdown>
    </HelpArticleFilePathContext.Provider>
  );

/** Minimal controllable IntersectionObserver stub. */
class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  callback: IntersectionObserverCallback;
  observe = vi.fn();
  disconnect = vi.fn();
  unobserve = vi.fn();
  takeRecords = vi.fn(() => []);
  root = null;
  rootMargin = '';
  thresholds = [];

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    MockIntersectionObserver.instances.push(this);
  }

  static reset() {
    MockIntersectionObserver.instances = [];
  }
}

describe('resolveHelpMediaSrc', () => {
  it('resolves ./ and bare relative paths against the article directory', () => {
    expect(resolveHelpMediaSrc('./media/x.gif', 'features/notebooks.md')).toBe('/help-content/features/media/x.gif');
    expect(resolveHelpMediaSrc('media/x.gif', 'features/notebooks.md')).toBe('/help-content/features/media/x.gif');
  });

  it('resolves ../ against the article directory', () => {
    expect(resolveHelpMediaSrc('../shared/x.webm', 'features/sub/a.md')).toBe('/help-content/features/shared/x.webm');
  });

  it('treats absolute paths as docs-root relative', () => {
    expect(resolveHelpMediaSrc('/images/x.png', 'features/a.md')).toBe('/help-content/images/x.png');
  });

  it('passes external URLs and empty src through untouched', () => {
    expect(resolveHelpMediaSrc('https://example.com/x.gif', 'features/a.md')).toBe('https://example.com/x.gif');
    expect(resolveHelpMediaSrc(undefined, 'features/a.md')).toBeUndefined();
  });

  it('routes admin-article media through the authenticated content API instead of /help-content/', () => {
    expect(resolveHelpMediaSrc('./media/x.gif', 'admin/settings.md', 'admin')).toBe(
      '/api/help/content?path=admin%2Fmedia%2Fx.gif'
    );
  });

  it('url-encodes the resolved path for the admin content API', () => {
    expect(resolveHelpMediaSrc('/admin/media/setup guide.png', 'admin/a.md', 'admin')).toBe(
      '/api/help/content?path=admin%2Fmedia%2Fsetup%20guide.png'
    );
  });

  it('still passes external URLs through untouched for admin articles', () => {
    expect(resolveHelpMediaSrc('https://example.com/x.gif', 'admin/a.md', 'admin')).toBe('https://example.com/x.gif');
  });
});

describe('help media rendering (public)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    MockIntersectionObserver.reset();
  });

  it('renders a GIF as a lazy image with a bundled help-content src', () => {
    renderMarkdown('![Create a project demo](./media/create-project.gif)');

    const img = screen.getByAltText('Create a project demo');
    expect(img.getAttribute('src')).toBe('/help-content/features/media/create-project.gif');
    expect(img.getAttribute('loading')).toBe('lazy');
  });

  it('renders a .webm as a gif-style video immediately when IntersectionObserver is unavailable', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    renderMarkdown('![Research mode walkthrough](./media/research-mode.webm)');

    const video = await screen.findByTestId('help-video-player');
    expect(video.getAttribute('src')).toBe('/help-content/features/media/research-mode.webm');
    expect(video.getAttribute('aria-label')).toBe('Research mode walkthrough');
    expect(video.hasAttribute('autoplay')).toBe(true);
    expect(video.hasAttribute('loop')).toBe(true);
    expect(video.hasAttribute('controls')).toBe(true);
    expect((video as HTMLVideoElement).muted).toBe(true);
  });

  it('omits aria-label when the markdown alt is empty', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    renderMarkdown('![](./media/silent.webm)');

    const video = await screen.findByTestId('help-video-player');
    expect(video.hasAttribute('aria-label')).toBe(false);
  });

  it('defers video mounting until the demo scrolls into view', async () => {
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
    renderMarkdown('![Slack setup demo](./media/slack-setup.mp4)');

    expect(screen.getByTestId('help-video-placeholder')).toBeDefined();
    expect(screen.queryByTestId('help-video-player')).toBeNull();

    const observer = MockIntersectionObserver.instances[0];
    expect(observer).toBeDefined();
    act(() => {
      observer.callback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        observer as unknown as IntersectionObserver
      );
    });

    const video = await screen.findByTestId('help-video-player');
    expect(video.getAttribute('src')).toBe('/help-content/features/media/slack-setup.mp4');
    expect(screen.queryByTestId('help-video-placeholder')).toBeNull();
    expect(observer.disconnect).toHaveBeenCalled();
  });

  it('renders a YouTube link as a privacy-preserving lazy embed', () => {
    renderMarkdown('![Enabling Research Mode](https://www.youtube.com/watch?v=dQw4w9WgXcQ)');
    const iframe = screen.getByTestId('help-youtube-iframe');
    expect(iframe.getAttribute('src')).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(iframe.getAttribute('title')).toBe('Enabling Research Mode');
    expect(iframe.getAttribute('loading')).toBe('lazy');
    expect(iframe.hasAttribute('allowfullscreen')).toBe(true);
    // Pinned: a demo clip needs no accelerometer/gyroscope/clipboard-write/web-share.
    expect(iframe.getAttribute('allow')).toBe('autoplay; encrypted-media; picture-in-picture; fullscreen');
  });

  it('accepts the youtu.be short-link form', () => {
    renderMarkdown('![demo](https://youtu.be/dQw4w9WgXcQ)');
    expect(screen.getByTestId('help-youtube-iframe').getAttribute('src')).toBe(
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'
    );
  });
});

/**
 * Admin media: a bare <img>/<video src> can't carry the Authorization Bearer
 * header /api/help/content requires (server/auth/auth.ts registers only
 * ExtractJwt.fromAuthHeaderAsBearerToken - no cookie extractor), so the
 * renderer must fetch the bytes itself and hand the element an object URL.
 * These tests stub fetch and URL.createObjectURL/revokeObjectURL (jsdom does
 * not implement either) to verify that flow end-to-end.
 */
describe('help media rendering (admin)', () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  let fetchMock: ReturnType<typeof vi.fn>;
  let createObjectURLMock: ReturnType<typeof vi.fn>;
  let revokeObjectURLMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    useAccessToken.setState({ accessToken: 'test-access-token' });
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      blob: () => Promise.resolve(new Blob(['fake-bytes'])),
    });
    createObjectURLMock = vi.fn(() => 'blob:mock-admin-media');
    revokeObjectURLMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    URL.createObjectURL = createObjectURLMock;
    URL.revokeObjectURL = revokeObjectURLMock;
  });

  afterEach(() => {
    useAccessToken.setState({ accessToken: null });
    vi.unstubAllGlobals();
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    MockIntersectionObserver.reset();
  });

  it('fetches admin image media from the authenticated route and renders the resulting object URL', async () => {
    renderMarkdown('![Setup demo](./media/setup.gif)', 'admin/settings.md', 'admin');

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/help/content?path=admin%2Fmedia%2Fsetup.gif', {
        credentials: 'include',
        headers: { Authorization: 'Bearer test-access-token' },
      });
    });

    await waitFor(() => {
      expect(screen.getByAltText('Setup demo').getAttribute('src')).toBe('blob:mock-admin-media');
    });
  });

  it('fetches admin video media only once the clip scrolls into view, not up front', async () => {
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
    renderMarkdown('![Admin demo](./media/admin-demo.webm)', 'admin/settings.md', 'admin');

    expect(screen.getByTestId('help-video-placeholder')).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();

    const observer = MockIntersectionObserver.instances[0];
    act(() => {
      observer.callback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        observer as unknown as IntersectionObserver
      );
    });

    const video = await screen.findByTestId('help-video-player');
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/help/content?path=admin%2Fmedia%2Fadmin-demo.webm', {
        credentials: 'include',
        headers: { Authorization: 'Bearer test-access-token' },
      });
    });
    await waitFor(() => {
      expect(video.getAttribute('src')).toBe('blob:mock-admin-media');
    });
  });

  it('revokes the object URL on unmount to avoid leaking memory', async () => {
    const { unmount } = renderMarkdown('![Setup demo](./media/setup.gif)', 'admin/settings.md', 'admin');

    await waitFor(() => {
      expect(screen.getByAltText('Setup demo').getAttribute('src')).toBe('blob:mock-admin-media');
    });

    unmount();
    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:mock-admin-media');
  });
});

describe('media path resolution through HelpContent', () => {
  const mockUseHelpContent = vi.mocked(useHelpContent);
  const appTheme = extendTheme({ ...getThemeConfig() });
  const TestWrapper = ({ children }: { children: React.ReactNode }) => (
    <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
  );

  beforeEach(() => {
    mockUseHelpContent.mockReset();
  });

  it('renders public article media unchanged when routed through the full HelpContent component', async () => {
    mockUseHelpContent.mockReturnValue({
      data: '![Setup demo](./media/setup.gif)',
      isLoading: false,
      error: null,
      filePath: 'features/notebooks.md',
      accessLevel: 'public',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    render(
      <TestWrapper>
        <HelpContent slug="features/notebooks" />
      </TestWrapper>
    );

    const img = await screen.findByAltText('Setup demo');
    expect(img.getAttribute('src')).toBe('/help-content/features/media/setup.gif');
  });

  describe('admin article', () => {
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      useAccessToken.setState({ accessToken: 'test-access-token' });
      fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        blob: () => Promise.resolve(new Blob(['fake-bytes'])),
      });
      vi.stubGlobal('fetch', fetchMock);
      URL.createObjectURL = vi.fn(() => 'blob:mock-admin-media');
      URL.revokeObjectURL = vi.fn();
    });

    afterEach(() => {
      useAccessToken.setState({ accessToken: null });
      vi.unstubAllGlobals();
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
    });

    it('resolves media against the displayed article even when the store still points at the previous one, via the authenticated route', async () => {
      // Cached-content navigation: useHelpContent returns the new article's data
      // synchronously (no loading phase) while useHelpPanel.currentFilePath still
      // holds the PREVIOUS article's path - the store is only synced from a
      // post-commit effect. Media must resolve from the article's own filePath,
      // not the store, or this first render computes a 404 URL that sticks.
      useHelpPanel.getState().setCurrentFilePath('features/notebooks.md');
      mockUseHelpContent.mockReturnValue({
        data: '![Setup demo](./media/setup.gif)',
        isLoading: false,
        error: null,
        filePath: 'admin/settings.md',
        accessLevel: 'admin',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      render(
        <TestWrapper>
          <HelpContent slug="admin/settings" />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith('/api/help/content?path=admin%2Fmedia%2Fsetup.gif', {
          credentials: 'include',
          headers: { Authorization: 'Bearer test-access-token' },
        });
      });

      const img = await screen.findByAltText('Setup demo');
      await waitFor(() => {
        expect(img.getAttribute('src')).toBe('blob:mock-admin-media');
      });
    });
  });
});
