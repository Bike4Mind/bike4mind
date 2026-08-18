import { describe, expect, it } from 'vitest';
import { renderEmbedWidgetHtml, serializeConfigForScript, type EmbedWidgetConfig } from './embedWidgetPage';

const BASE_CONFIG: EmbedWidgetConfig = {
  embedKey: 'b4m_live_widget_key',
  agentId: 'agent-1',
};

describe('serializeConfigForScript', () => {
  it('neutralizes a script-terminator breakout in config values', () => {
    const hostile = serializeConfigForScript({
      ...BASE_CONFIG,
      displayName: '</scr' + 'ipt><scr' + 'ipt>alert(1)</scr' + 'ipt>',
    });
    expect(hostile).not.toContain('<');
    // Still valid JSON that round-trips to the original value.
    const parsed = JSON.parse(hostile);
    expect(parsed.displayName).toBe('</scr' + 'ipt><scr' + 'ipt>alert(1)</scr' + 'ipt>');
  });

  it('neutralizes a comment-open breakout', () => {
    const out = serializeConfigForScript({ ...BASE_CONFIG, displayName: '<!-- sneaky' });
    expect(out).not.toContain('<!--');
  });

  it('escapes U+2028/U+2029 (legal JSON, illegal in a JS string literal)', () => {
    const out = serializeConfigForScript({ ...BASE_CONFIG, displayName: 'a\u2028b\u2029c' });
    expect(out).toContain('\\u2028');
    expect(out).toContain('\\u2029');
    expect(JSON.parse(out).displayName).toBe('a\u2028b\u2029c');
  });

  it('round-trips quotes and unicode untouched', () => {
    const name = 'The "Best" Bot \u00e9\u{1f916}';
    const out = serializeConfigForScript({ ...BASE_CONFIG, displayName: name });
    expect(JSON.parse(out).displayName).toBe(name);
  });
});

describe('renderEmbedWidgetHtml', () => {
  it('contains no premature closing script tag that would truncate the inline script', () => {
    const html = renderEmbedWidgetHtml({
      ...BASE_CONFIG,
      displayName: 'hostile </scr' + 'ipt> name',
    });
    // Simulate the HTML tokenizer's script-data state: once inside <script ...>,
    // ONLY a literal closer exits the block - JS comments/strings are NOT
    // understood. Walk the paired blocks and count the closers consumed as
    // legitimate terminators; a leftover one means a block ended early.
    let i = 0;
    let consumed = 0;
    for (;;) {
      const open = html.indexOf('<script', i);
      if (open === -1) break;
      const openEnd = html.indexOf('>', open);
      expect(openEnd).toBeGreaterThan(-1);
      const close = html.indexOf('</script>', openEnd);
      expect(close).toBeGreaterThan(-1);
      consumed++;
      i = close + '</script>'.length;
    }
    const totalCloses = (html.match(/<\/script>/gi) || []).length;
    expect(consumed).toBe(totalCloses);
    expect(consumed).toBeGreaterThan(0);
  });

  it('interpolates the SSE parser source into the page script', () => {
    const html = renderEmbedWidgetHtml(BASE_CONFIG);
    expect(html).toContain('function createSseParser(');
    expect(html).toContain('createSseParser({');
  });

  it('embeds the key only inside the escaped config blob', () => {
    const html = renderEmbedWidgetHtml(BASE_CONFIG);
    const occurrences = html.split('b4m_live_widget_key').length - 1;
    expect(occurrences).toBe(1);
    expect(html).toContain('__B4M_EMBED__');
  });

  it('defaults to relative same-origin endpoints and allows overrides', () => {
    const html = renderEmbedWidgetHtml(BASE_CONFIG);
    expect(html).toContain('"sessionPath":"/api/embed/session"');
    expect(html).toContain('"chatPath":"/api/embed/chat"');

    const custom = renderEmbedWidgetHtml({ ...BASE_CONFIG, sessionPath: '/api/custom/session' });
    expect(custom).toContain('"sessionPath":"/api/custom/session"');
  });

  it('renders the a11y and mobile scaffolding', () => {
    const html = renderEmbedWidgetHtml(BASE_CONFIG);
    expect(html).toContain('name="viewport"');
    expect(html).toContain('role="log"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-label="Type a message"');
  });

  it('never renders displayName into HTML text directly (config blob only)', () => {
    const html = renderEmbedWidgetHtml({ ...BASE_CONFIG, displayName: 'UNIQUE_NAME_SENTINEL' });
    const occurrences = html.split('UNIQUE_NAME_SENTINEL').length - 1;
    expect(occurrences).toBe(1); // inside window.__B4M_EMBED__ only; textContent renders it at runtime
  });

  it('emits the color override style for a valid hex primaryColor', () => {
    const html = renderEmbedWidgetHtml({ ...BASE_CONFIG, primaryColor: '#AA00FF' });
    expect(html).toContain('<style>:root{--b4m-primary:#aa00ff}</style>');
  });

  it('keeps primaryColor out of the config JSON entirely', () => {
    const html = renderEmbedWidgetHtml({ ...BASE_CONFIG, primaryColor: '#aa00ff' });
    expect(html).not.toContain('"primaryColor"');
  });

  it('emits no override style for an invalid primaryColor (render-time re-check)', () => {
    // Stored data may predate write validation; the renderer must re-validate.
    const html = renderEmbedWidgetHtml({
      ...BASE_CONFIG,
      primaryColor: '#fff;}body{background:url(//evil.example)}',
    });
    expect(html).not.toContain(':root{--b4m-primary');
    expect(html).not.toContain('evil.example');
  });

  it('emits no override style when primaryColor is absent (unbranded regression)', () => {
    const html = renderEmbedWidgetHtml(BASE_CONFIG);
    expect(html).not.toContain(':root{--b4m-primary');
    // The stylesheet still carries the default via the CSS variable fallback.
    expect(html).toContain('var(--b4m-primary, #2b6cb0)');
  });

  it('carries logoUrl inside the config blob only', () => {
    const html = renderEmbedWidgetHtml({ ...BASE_CONFIG, logoUrl: 'https://logos.example/acme.png' });
    const occurrences = html.split('https://logos.example/acme.png').length - 1;
    expect(occurrences).toBe(1);
    expect(html).toContain('"logoUrl"');
  });

  it('neutralizes a script-terminator smuggled through logoUrl', () => {
    const html = renderEmbedWidgetHtml({
      ...BASE_CONFIG,
      logoUrl: 'https://logos.example/x</scr' + 'ipt><script>alert(1)</scr' + 'ipt>',
    });
    // serializeConfigForScript escapes every `<`; no raw closer can appear.
    expect(html).not.toContain('x</script>');
  });
});
