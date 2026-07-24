import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import ReactMarkdown from 'react-markdown';

vi.mock('@client/app/hooks/useHelpContent');
vi.mock('./HelpFeedbackWidget', () => ({ default: () => null }));

import { useHelpContent } from '@client/app/hooks/useHelpContent';
import { useHelpPanel } from '@client/app/hooks/useHelpPanel';
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

const renderMarkdown = (md: string, filePath = 'features/projects.md') =>
  render(
    <HelpArticleFilePathContext.Provider value={filePath}>
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
});

describe('help media rendering', () => {
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

  it('resolves media against the displayed article even when the store still points at the previous one', async () => {
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    render(
      <TestWrapper>
        <HelpContent slug="admin/settings" />
      </TestWrapper>
    );

    const img = await screen.findByAltText('Setup demo');
    expect(img.getAttribute('src')).toBe('/help-content/admin/media/setup.gif');
  });
});
