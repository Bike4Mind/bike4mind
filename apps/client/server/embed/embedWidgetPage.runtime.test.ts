// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildMetaEvent, buildSSEEvent, serializeSSEEvent, SSE_DONE_SIGNAL } from '@bike4mind/common';
import { EMBED_WIDGET_JS, renderEmbedWidgetHtml, type EmbedWidgetConfig } from './embedWidgetPage';

// Exercise the EXACT IIFE the page ships (not a copy) in a real DOM against a
// stubbed fetch - string-only assertions previously let a byte-cap bug through.

const CONFIG: EmbedWidgetConfig = { embedKey: 'b4m_live_x', agentId: 'a1' };

/** An SSE Response whose body streams the given text as content frames + [DONE]. */
function sseResponse(text: string) {
  const chunks = [
    serializeSSEEvent(buildMetaEvent('req-1')),
    serializeSSEEvent(buildSSEEvent(['', text])),
    SSE_DONE_SIGNAL,
  ];
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return { ok: true, status: 200, headers: { get: () => 'text/event-stream' }, body };
}

/** Render the real page markup into the jsdom document, seed config, run the IIFE. */
function mountWidget(config: EmbedWidgetConfig = CONFIG): void {
  const html = renderEmbedWidgetHtml(config);
  const bodyInner = html.slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('<script>'));
  document.body.innerHTML = bodyInner;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__B4M_EMBED__ = {
    ...config,
    sessionPath: '/api/embed/session',
    chatPath: '/api/embed/chat',
  };

  (0, eval)(EMBED_WIDGET_JS);
}

function type(text: string): void {
  const input = document.getElementById('b4m-input') as HTMLTextAreaElement;
  input.value = text;
  (document.getElementById('b4m-send') as HTMLButtonElement).click();
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).__B4M_EMBED__;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).__b4mEmbedMounted;
});

describe('embed widget runtime (real IIFE in jsdom)', () => {
  it('mints a session then streams an assistant reply into the transcript', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/embed/session') return { ok: true, status: 200, json: async () => ({ session_token: 'tok' }) };
      return sseResponse('hello from the agent');
    });
    vi.stubGlobal('fetch', fetchMock);

    mountWidget();
    type('hi there');

    await vi.waitFor(() => {
      expect(document.querySelector('.b4m-msg-assistant')?.textContent).toBe('hello from the agent');
    });
    // session minted, then chat called, in that order
    expect(fetchMock.mock.calls[0][0]).toBe('/api/embed/session');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/embed/chat');
    // input re-enabled after the stream finishes
    expect((document.getElementById('b4m-input') as HTMLTextAreaElement).disabled).toBe(false);
  });

  it('re-mints once on a 401 and retries the chat', async () => {
    let chatCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/embed/session') return { ok: true, status: 200, json: async () => ({ session_token: 'tok' }) };
      chatCalls += 1;
      if (chatCalls === 1) return { ok: false, status: 401, headers: { get: () => 'application/json' } };
      return sseResponse('after remint');
    });
    vi.stubGlobal('fetch', fetchMock);

    mountWidget();
    type('hi');

    await vi.waitFor(() => {
      expect(document.querySelector('.b4m-msg-assistant')?.textContent).toBe('after remint');
    });
    // session minted twice (initial + re-mint), chat attempted twice
    expect(fetchMock.mock.calls.filter(c => c[0] === '/api/embed/session')).toHaveLength(2);
    expect(chatCalls).toBe(2);
  });

  it('caps the resent history by UTF-8 bytes so a huge CJK turn stays under 1MB', async () => {
    let chatBody = '';
    const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
      if (url === '/api/embed/session') return { ok: true, status: 200, json: async () => ({ session_token: 'tok' }) };
      chatBody = init?.body ?? '';
      return sseResponse('ok');
    });
    vi.stubGlobal('fetch', fetchMock);

    mountWidget();
    // ~890k code units of a 3-byte CJK char = ~2.67MB UTF-8: under a naive
    // code-unit cap but over the route's 1mb byte limit if not measured in bytes.
    type('中'.repeat(890_000));

    await vi.waitFor(() => expect(chatBody).not.toBe(''));
    expect(new TextEncoder().encode(chatBody).length).toBeLessThan(1_000_000);
  });

  it('renders an https logo image in the header with the title as alt text', () => {
    mountWidget({ ...CONFIG, displayName: 'Acme Support', logoUrl: 'https://logos.example/acme.png' });
    const logo = document.querySelector('#b4m-header img#b4m-logo') as HTMLImageElement;
    expect(logo).toBeTruthy();
    expect(logo.src).toBe('https://logos.example/acme.png');
    expect(logo.alt).toBe('Acme Support');
    expect(document.querySelector('#b4m-header span')?.textContent).toBe('Acme Support');
  });

  it('removes the logo from the header when it fails to load', () => {
    mountWidget({ ...CONFIG, logoUrl: 'https://logos.example/broken.png' });
    const logo = document.getElementById('b4m-logo') as HTMLImageElement;
    expect(logo).toBeTruthy();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (logo as any).onerror();
    expect(document.getElementById('b4m-logo')).toBeNull();
  });

  it.each([['javascript:alert(1)'], ['http://logos.example/acme.png'], ['//logos.example/acme.png']])(
    'renders no logo for a non-https logoUrl (%s) even if it reached the config',
    logoUrl => {
      mountWidget({ ...CONFIG, logoUrl });
      expect(document.getElementById('b4m-logo')).toBeNull();
    }
  );

  it('renders the header title without a logo when no logoUrl is configured', () => {
    mountWidget({ ...CONFIG, displayName: 'Plain' });
    expect(document.getElementById('b4m-logo')).toBeNull();
    expect(document.querySelector('#b4m-header span')?.textContent).toBe('Plain');
  });

  it('renders the footer only when a poweredByLabel is present', () => {
    mountWidget({ ...CONFIG, poweredByLabel: 'Powered by Bike4Mind' });
    expect(document.getElementById('b4m-footer')?.textContent).toBe('Powered by Bike4Mind');

    document.body.innerHTML = '';
    mountWidget(CONFIG);
    // The server omitting the label IS the hide-branding transport; the widget
    // must render nothing rather than a fallback.
    expect(document.getElementById('b4m-footer')?.textContent).toBe('');
  });
});
