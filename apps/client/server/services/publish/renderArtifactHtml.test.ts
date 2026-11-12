import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ArtifactType } from '@bike4mind/common';
import { renderArtifactIndexHtml } from './renderArtifactHtml';

/**
 * Published bytes pinned per artifact type. Customer /p/ pages were built from these exact bytes,
 * so any drift changes a live page. The fixtures were captured from the web client's pre-render
 * (`buildArtifactIndexHtml`, since removed) before the client switched to raw upload; regenerate
 * only for an intended change to published output.
 *
 * `react` is absent: finalize transpiles it via `buildReactArtifactBundle`, pinned in
 * `reactBundlePinned.test.ts`.
 */
const TITLE = 'My "Cool" <Artifact> & Friends';

// The footer reads brand env at module load, so it is fixed here and the module re-imported.
const BRAND_ENV: Record<string, string> = {
  NEXT_PUBLIC_APP_NAME: 'acme',
  APP_NAME: '',
  SEED_APP_NAME: '',
  NEXT_PUBLIC_WEBSITE_URL: 'https://acme.example',
  NEXT_PUBLIC_CANONICAL_ORIGIN: '',
  NEXT_PUBLIC_SHARE_BUILTIN_LOGO: '',
  NEXT_PUBLIC_SHARE_BRAND_NAVY: '',
  NEXT_PUBLIC_SHARE_BRAND_LIME: '',
  NEXT_PUBLIC_SHARE_BRAND_ORANGE: '',
};

const PINNED_CASES: Record<string, { type: Exclude<ArtifactType, 'react'>; content: string }> = {
  'html-document': {
    type: 'html',
    content: '<!doctype html><html lang="en"><head><title>x</title></head><body><h1>Hi</h1></body></html>',
  },
  'html-document-no-body-close': {
    type: 'html',
    content: '<html><head><title>x</title></head><h1>no body close</h1></html>',
  },
  'html-fragment': { type: 'html', content: '<h1>Just a fragment</h1><p>hi</p>' },
  // The client uploads the content untrimmed, and the server decodes it as UTF-8.
  'html-fragment-untrimmed-non-ascii': {
    type: 'html',
    content: `\n  <p>caf${String.fromCodePoint(0xe9)} ${String.fromCodePoint(0x2014)} ${String.fromCodePoint(0x1f680)}</p>\n\n`,
  },
  svg: { type: 'svg', content: '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>' },
  code: { type: 'code', content: 'const x = 1 < 2 && 3 > 2;\nconsole.log("<script>");' },
  python: { type: 'python', content: 'print("hello & <world>")' },
  mermaid: { type: 'mermaid', content: 'graph TD;\n  A-->B;' },
  recharts: { type: 'recharts', content: '{"type":"bar","data":[1,2,3]}' },
};

const pinned = (name: string) =>
  readFileSync(resolve(__dirname, '__fixtures__/renderArtifactHtml', `${name}.html`), 'utf8');

describe('renderArtifactIndexHtml pinned published bytes', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function loadRenderer() {
    vi.resetModules();
    for (const [key, value] of Object.entries(BRAND_ENV)) vi.stubEnv(key, value);
    return (await import('./renderArtifactHtml')).renderArtifactIndexHtml;
  }

  it.each(Object.keys(PINNED_CASES))('%s matches its pinned page', async name => {
    const render = await loadRenderer();
    const { type, content } = PINNED_CASES[name];
    expect(render(type, content, TITLE)).toBe(pinned(name));
  });

  it.each(Object.keys(PINNED_CASES))('%s: the client pre-render emits the same pinned page', async name => {
    vi.resetModules();
    for (const [key, value] of Object.entries(BRAND_ENV)) vi.stubEnv(key, value);
    const { buildArtifactIndexHtml } = await import('@client/app/utils/publishApi');
    const { type, content } = PINNED_CASES[name];
    expect(buildArtifactIndexHtml(type, content, TITLE)).toBe(pinned(name));
  });

  it('round-trips the UTF-8 bytes finalize decodes from the upload', async () => {
    const render = await loadRenderer();
    const { type, content } = PINNED_CASES['html-fragment-untrimmed-non-ascii'];
    const uploaded = Buffer.from(new TextEncoder().encode(content)).toString('utf-8');
    expect(render(type, uploaded, TITLE)).toBe(pinned('html-fragment-untrimmed-non-ascii'));
  });
});

describe('renderArtifactIndexHtml', () => {
  const title = TITLE;

  it('injects the footer before </body> for a full HTML document', () => {
    const out = renderArtifactIndexHtml('html', '<html><body><h1>Hi</h1></body></html>', title);
    expect(out.startsWith('<html><body><h1>Hi</h1>')).toBe(true);
    // Whatever the footer resolves to (env-dependent), it lands before the closing tag.
    expect(out.endsWith('</body></html>')).toBe(true);
  });

  it('wraps fragments and svg in a doctype page shell with the escaped title', () => {
    const frag = renderArtifactIndexHtml('html', '<h1>frag</h1>', title);
    expect(frag.startsWith('<!doctype html>')).toBe(true);
    expect(frag).toContain('<title>My &quot;Cool&quot; &lt;Artifact&gt; &amp; Friends</title>');
    expect(frag).toContain('<h1>frag</h1>');
  });

  it('escapes source content in the code view', () => {
    const out = renderArtifactIndexHtml('code', '1 < 2 && "x" > \'y\'', title);
    expect(out).toContain('<pre><code>1 &lt; 2 &amp;&amp; &quot;x&quot; &gt; &#39;y&#39;</code></pre>');
  });

  it('falls back to the default title when none is given', () => {
    const out = renderArtifactIndexHtml('svg', '<svg/>', '');
    expect(out).toContain('<title>Shared artifact</title>');
  });

  it('throws on react rather than code-viewing raw JSX', () => {
    expect(() => renderArtifactIndexHtml('react', '<App/>', title)).toThrow(/transpiled/);
  });
});
