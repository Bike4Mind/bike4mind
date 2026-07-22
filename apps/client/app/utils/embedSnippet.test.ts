import { describe, expect, it } from 'vitest';
import {
  buildIframeSnippet,
  buildScriptSnippet,
  EMBED_CHAT_PATH,
  EMBED_KEY_PLACEHOLDER,
  EMBED_WIDGET_PATH,
} from './embedSnippet';

const BASE = { baseUrl: 'https://app.example.com', embedKey: 'b4m_live_abc' };

describe('buildScriptSnippet', () => {
  it('emits one script tag pointing at the loader with the key as a data attribute', () => {
    const s = buildScriptSnippet(BASE);
    expect(s).toBe(
      `<script src="https://app.example.com${EMBED_WIDGET_PATH}" data-key="b4m_live_abc" async></scr` + `ipt>`
    );
  });

  it('escapes hostile attribute values', () => {
    const s = buildScriptSnippet({ ...BASE, embedKey: 'x" onload="alert(1)' });
    expect(s).not.toContain('" onload="');
    expect(s).toContain('&quot;');
  });

  it('tolerates a trailing slash on baseUrl and includes position when given', () => {
    const s = buildScriptSnippet({ ...BASE, baseUrl: 'https://app.example.com/', position: 'bottom-left' });
    expect(s).toContain(`src="https://app.example.com${EMBED_WIDGET_PATH}"`);
    expect(s).toContain('data-position="bottom-left"');
  });
});

describe('buildIframeSnippet', () => {
  it('emits an iframe at the pretty path with the key url-encoded under ?k=', () => {
    const s = buildIframeSnippet({ ...BASE, embedKey: 'b4m_live_a+b/c' });
    expect(s).toContain(`src="https://app.example.com${EMBED_CHAT_PATH}?k=b4m_live_a%2Bb%2Fc"`);
    expect(s).toContain('loading="lazy"');
    expect(s).toContain('width="400"');
    expect(s).toContain('height="600"');
  });

  it('uses the agent title for accessibility and escapes it', () => {
    const s = buildIframeSnippet({ ...BASE, title: 'Sales "Bot" <1>' });
    expect(s).toContain('title="Sales &quot;Bot&quot; &lt;1&gt; chat"');
  });

  it('supports custom dimensions and the key placeholder', () => {
    const s = buildIframeSnippet({ ...BASE, embedKey: EMBED_KEY_PLACEHOLDER, width: '100%', height: 700 });
    expect(s).toContain('width="100%"');
    expect(s).toContain('height="700"');
    expect(s).toContain(`?k=${EMBED_KEY_PLACEHOLDER}`);
  });
});
