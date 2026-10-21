import { renderToStaticMarkup } from 'react-dom/server';
import { CssVarsProvider } from '@mui/joy/styles';
import { describe, expect, it } from 'vitest';
import { MAX_BROWSER_TABS } from '@shared/browserTabs';
import type { BrowserTabSummary } from '@shared/ipc';
import { BrowserTabStrip, browserTabLabel } from './BrowserTabStrip';

const tab = (id: number, title: string, url: string, loading = false): BrowserTabSummary => ({
  id,
  title,
  url,
  loading,
});

const render = (tabs: BrowserTabSummary[], activeTabId: number | null) =>
  renderToStaticMarkup(
    <CssVarsProvider>
      <BrowserTabStrip
        tabs={tabs}
        activeTabId={activeTabId}
        onSelect={() => undefined}
        onClose={() => undefined}
        onNew={() => undefined}
      />
    </CssVarsProvider>
  );

describe('browserTabLabel', () => {
  it('prefers the title, then the host while it has none, then "New tab"', () => {
    expect(browserTabLabel(tab(1, 'Docs', 'https://example.com/docs'))).toBe('Docs');
    expect(browserTabLabel(tab(1, '', 'https://example.com:8443/docs'))).toBe('example.com:8443');
    expect(browserTabLabel(tab(1, '', ''))).toBe('New tab');
  });
});

describe('BrowserTabStrip', () => {
  it('gives every tab a close button and a tooltip naming its title and address', () => {
    const html = render([tab(1, 'Docs', 'https://example.com/docs'), tab(2, '', '')], 1);
    expect(html.match(/data-testid="browser-tab-close-btn"/g)).toHaveLength(2);
    expect(html).toContain('title="Docs\nhttps://example.com/docs"');
    expect(html).toContain('title="New tab"');
    expect(html).toContain('aria-label="Close Docs"');
  });

  it('disables the plus at the cap and says why', () => {
    const full = Array.from({ length: MAX_BROWSER_TABS }, (_, index) => tab(index + 1, `Tab ${index + 1}`, ''));
    const plus = (html: string) => html.match(/<button[^>]*data-testid="browser-tab-new-btn"[^>]*>/)?.[0] ?? '';
    expect(plus(render(full, 1))).toContain('disabled');
    expect(plus(render(full, 1))).toContain(`title="At most ${MAX_BROWSER_TABS} tabs"`);
    expect(plus(render([], null))).not.toContain('disabled');
  });
});
