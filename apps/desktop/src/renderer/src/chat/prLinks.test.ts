import { describe, expect, it, vi } from 'vitest';
import { isBrowsableUrl, openInSessionBrowser, routePrLink, type PrLinkTargets } from './prLinks';

const PR = 'https://github.com/example-org/widgets/pull/611';
const PLAIN = { metaKey: false, ctrlKey: false };

function fakeTargets(navigate: PrLinkTargets['navigate'] = async () => undefined) {
  return { openExternal: vi.fn(async () => undefined), navigate: vi.fn(navigate) };
}

describe('routePrLink', () => {
  it('sends a plain click to the built-in browser', () => {
    const targets = fakeTargets();
    const openBuiltIn = vi.fn();
    routePrLink(PR, PLAIN, openBuiltIn, targets);
    expect(openBuiltIn).toHaveBeenCalledWith(PR);
    expect(targets.openExternal).not.toHaveBeenCalled();
  });

  it.each([
    ['Cmd', { metaKey: true, ctrlKey: false }],
    ['Ctrl', { metaKey: false, ctrlKey: true }],
  ])('sends a %s-click to the system browser', (_label, click) => {
    const targets = fakeTargets();
    const openBuiltIn = vi.fn();
    routePrLink(PR, click, openBuiltIn, targets);
    expect(targets.openExternal).toHaveBeenCalledWith(PR);
    expect(openBuiltIn).not.toHaveBeenCalled();
  });

  it('routes a CI check details link the same way', () => {
    const targets = fakeTargets();
    const openBuiltIn = vi.fn();
    const details = 'https://github.com/example-org/widgets/actions/runs/1/job/2';
    routePrLink(details, PLAIN, openBuiltIn, targets);
    expect(openBuiltIn).toHaveBeenCalledWith(details);
  });

  it('falls back to the system browser where the bar has no pane to open', () => {
    const targets = fakeTargets();
    routePrLink(PR, PLAIN, undefined, targets);
    expect(targets.openExternal).toHaveBeenCalledWith(PR);
  });

  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'mailto:someone@example.com', 'not a url'])(
    'refuses %s everywhere',
    url => {
      const targets = fakeTargets();
      const openBuiltIn = vi.fn();
      routePrLink(url, PLAIN, openBuiltIn, targets);
      routePrLink(url, { metaKey: true, ctrlKey: false }, openBuiltIn, targets);
      expect(openBuiltIn).not.toHaveBeenCalled();
      expect(targets.openExternal).not.toHaveBeenCalled();
    }
  );
});

describe('openInSessionBrowser', () => {
  it("shows the session's pane and navigates it", async () => {
    const targets = fakeTargets();
    const showPane = vi.fn();
    openInSessionBrowser(PR, 'session-1', showPane, targets);
    expect(showPane).toHaveBeenCalledTimes(1);
    expect(targets.navigate).toHaveBeenCalledWith({ sessionId: 'session-1', url: PR });
    await Promise.resolve();
    expect(targets.openExternal).not.toHaveBeenCalled();
  });

  it('falls back to the system browser with no session', () => {
    const targets = fakeTargets();
    const showPane = vi.fn();
    openInSessionBrowser(PR, null, showPane, targets);
    expect(targets.openExternal).toHaveBeenCalledWith(PR);
    expect(showPane).not.toHaveBeenCalled();
    expect(targets.navigate).not.toHaveBeenCalled();
  });

  it('falls back to the system browser when the pane refuses the navigation', async () => {
    const targets = fakeTargets(async () => {
      throw new Error('refused');
    });
    openInSessionBrowser(PR, 'session-1', vi.fn(), targets);
    await vi.waitFor(() => expect(targets.openExternal).toHaveBeenCalledWith(PR));
  });

  it('refuses a non-web url before touching the pane', () => {
    const targets = fakeTargets();
    const showPane = vi.fn();
    openInSessionBrowser('javascript:alert(1)', 'session-1', showPane, targets);
    expect(showPane).not.toHaveBeenCalled();
    expect(targets.navigate).not.toHaveBeenCalled();
    expect(targets.openExternal).not.toHaveBeenCalled();
  });
});

describe('isBrowsableUrl', () => {
  it('takes http and https only', () => {
    expect(isBrowsableUrl('https://github.com')).toBe(true);
    expect(isBrowsableUrl('http://localhost:3000')).toBe(true);
    expect(isBrowsableUrl('file:///tmp/x')).toBe(false);
  });
});
