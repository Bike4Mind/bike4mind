import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CookieImportState } from '@shared/browserCookies';
import type { BrowserPaneState } from '@shared/ipc';
import { BrowserNavbar } from './BrowserNavbar';

const PAGE: BrowserPaneState = {
  url: 'https://shop.example.com/',
  canGoBack: false,
  canGoForward: false,
  loading: false,
  error: '',
};
const NOTHING: CookieImportState = { supported: true, unsupported: '', sites: [] };

const render = (cookies: CookieImportState) =>
  renderToStaticMarkup(
    <BrowserNavbar
      state={PAGE}
      cookies={cookies}
      onNavigate={() => undefined}
      onGo={() => undefined}
      onCookieState={() => undefined}
    />
  );

describe('the standing cookie indicator', () => {
  it('is not drawn when the jar holds nothing of the user', () => {
    expect(render(NOTHING)).not.toContain('chat-browser-cookies-indicator');
  });

  /**
   * The requirement this is here for: while the agent's browser carries the user's own logins,
   * that has to be readable at a glance by someone who was not watching when it started. A
   * toast would not be, which is why this is asserted rather than left to the import's own
   * confirmation.
   */
  it('names every imported site, standing, with a clear beside it', () => {
    const html = render({
      supported: true,
      unsupported: '',
      sites: [
        { host: 'shop.example.com', cookies: 4, profile: 'Default' },
        { host: 'forum.example.test', cookies: 2, profile: 'Default' },
      ],
    });

    expect(html).toContain('chat-browser-cookies-indicator');
    expect(html).toContain('Signed in as you on shop.example.com, forum.example.test');
    expect(html).toContain('chat-browser-cookies-indicator-clear');
  });

  it('still offers the menu when importing is not available at all', () => {
    const html = render({ supported: false, unsupported: 'Only on macOS.', sites: [] });
    expect(html).toContain('chat-browser-menu');
    expect(html).not.toContain('chat-browser-cookies-indicator');
  });
});
