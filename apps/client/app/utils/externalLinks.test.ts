import { describe, it, expect, vi, afterEach } from 'vitest';
import { openInNewTab, openExternalLink } from './externalLinks';

/** Capture the anchors that get .click()ed (the helper opens via a transient anchor). */
function spyAnchorClicks(): HTMLAnchorElement[] {
  const clicked: HTMLAnchorElement[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push(this);
  });
  return clicked;
}

describe('openInNewTab', () => {
  afterEach(() => vi.restoreAllMocks());

  // The bug this guards against: window.open with ANY feature string spawns a
  // popup WINDOW instead of a tab. We open via an <a target="_blank"> instead,
  // which opens a tab AND carries rel="noopener noreferrer" at open time.
  it('opens via an anchor with target _blank and rel "noopener noreferrer"', () => {
    const clicked = spyAnchorClicks();

    openInNewTab('https://example.com/foo');

    expect(clicked).toHaveLength(1);
    expect(clicked[0].getAttribute('href')).toBe('https://example.com/foo');
    expect(clicked[0].target).toBe('_blank');
    // Both halves of the old 'noopener,noreferrer' contract are preserved.
    expect(clicked[0].rel).toBe('noopener noreferrer');
  });

  it('does NOT call window.open (which a feature string would turn into a popup window)', () => {
    spyAnchorClicks();
    const openSpy = vi.spyOn(window, 'open');

    openInNewTab('https://example.com/foo');

    expect(openSpy).not.toHaveBeenCalled();
  });

  it('cleans up the transient anchor after clicking', () => {
    spyAnchorClicks();
    openInNewTab('https://example.com/foo');
    expect(document.querySelector('a[href="https://example.com/foo"]')).toBeNull();
  });

  it('no-ops on a falsy URL (never clicks an anchor)', () => {
    const clicked = spyAnchorClicks();
    openInNewTab(undefined);
    openInNewTab(null);
    openInNewTab('');
    expect(clicked).toHaveLength(0);
  });
});

describe('openExternalLink', () => {
  afterEach(() => vi.restoreAllMocks());

  it('routes through the tab-opening anchor path', () => {
    const clicked = spyAnchorClicks();

    openExternalLink('https://example.com/bar');

    expect(clicked).toHaveLength(1);
    expect(clicked[0].getAttribute('href')).toBe('https://example.com/bar');
    expect(clicked[0].rel).toBe('noopener noreferrer');
  });
});
