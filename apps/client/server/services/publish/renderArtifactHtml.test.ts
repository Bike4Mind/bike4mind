import { describe, it, expect } from 'vitest';
import { renderArtifactIndexHtml } from './renderArtifactHtml';
import { buildArtifactIndexHtml } from '@client/app/utils/publishApi';

/**
 * The server renderer is the permanent home for artifact -> published bytes. Until #1492
 * removes the web client's pre-render, both must emit BYTE-IDENTICAL output so switching the
 * client to raw upload cannot change any already-published page. These tests pin the server
 * output to the current client output (`buildArtifactIndexHtml`) per artifact type.
 *
 * `react` is intentionally absent: the client uploads raw JSX (it does not pre-render react)
 * and finalize transpiles it via `buildReactArtifactBundle` - that path is covered by
 * `transpileReactArtifact.test.ts`, not this wrapper.
 */
describe('renderArtifactIndexHtml byte-parity with the client pre-render', () => {
  const title = 'My "Cool" <Artifact> & Friends';

  const cases: Array<{ name: string; type: Parameters<typeof renderArtifactIndexHtml>[0]; content: string }> = [
    {
      name: 'html with <!doctype> (full document)',
      type: 'html',
      content: '<!doctype html><html lang="en"><head><title>x</title></head><body><h1>Hi</h1></body></html>',
    },
    {
      name: 'html full document without a </body> (footer appended)',
      type: 'html',
      content: '<html><head><title>x</title></head><h1>no body close</h1></html>',
    },
    { name: 'html fragment (wrapped in page shell)', type: 'html', content: '<h1>Just a fragment</h1><p>hi</p>' },
    {
      name: 'svg (wrapped in page shell)',
      type: 'svg',
      content: '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
    },
    { name: 'code (code view)', type: 'code', content: 'const x = 1 < 2 && 3 > 2;\nconsole.log("<script>");' },
    { name: 'python (code view)', type: 'python', content: 'print("hello & <world>")' },
    { name: 'mermaid (code view)', type: 'mermaid', content: 'graph TD;\n  A-->B;' },
    { name: 'recharts (code view)', type: 'recharts', content: '{"type":"bar","data":[1,2,3]}' },
  ];

  it.each(cases)('matches the client output for $name', ({ type, content }) => {
    expect(renderArtifactIndexHtml(type, content, title)).toBe(buildArtifactIndexHtml(type, content, title));
  });

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
