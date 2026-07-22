import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import ReactMarkdown from 'react-markdown';
import { remarkPlugins, rehypePlugins, markdownComponents, resolveHelpMediaSrc } from './HelpContent';
import { useHelpPanel } from '@client/app/hooks/useHelpPanel';

/**
 * Media embedding in help articles: GIFs/images render as lazy <img>, and
 * .webm/.mp4 demo videos (authored with the same ![alt](path) image syntax)
 * render as lazy gif-style <video>. Rendered through the exact production
 * pipeline exported by HelpContent.tsx.
 */

const renderMarkdown = (md: string) =>
  render(
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={markdownComponents}>
      {md}
    </ReactMarkdown>
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
  beforeEach(() => {
    useHelpPanel.getState().setCurrentFilePath('features/projects.md');
  });

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
