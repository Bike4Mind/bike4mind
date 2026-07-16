import { describe, it, expect } from 'vitest';
import { convertCodeBlocksToArtifacts } from './artifactParser';
import { parseArtifacts, isSvgGraphicallyEmpty } from './artifactParser';

/**
 * Regression coverage for the artifact parser hardening (gaps B & C):
 * bare <!DOCTYPE>/<html> documents and ```html fragments must be promoted to
 * artifacts so raw HTML never leaks into the chat, while content that is already
 * tagged or inside a generic code fence must be left untouched.
 */
describe('convertCodeBlocksToArtifacts — HTML promotion (#9259)', () => {
  const promote = (input: string) => {
    const converted = convertCodeBlocksToArtifacts(input);
    const { artifacts } = parseArtifacts(converted);
    return { converted, artifacts, wrappers: (converted.match(/<artifact /g) || []).length };
  };

  it('promotes a bare <!DOCTYPE html> document with no fence and no tag', () => {
    const { artifacts } = promote(
      'Here is your page:\n<!DOCTYPE html>\n<html><head><title>My Page</title></head><body><h1>Hi</h1></body></html>\nDone.'
    );
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].type).toBe('html');
    expect(artifacts[0].title).toBe('My Page');
  });

  it('promotes a bare <html>…</html> document without a doctype', () => {
    const { artifacts } = promote('<html><body><p>no doctype here</p></body></html>');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].type).toBe('html');
  });

  it('promotes an HTML fragment inside a ```html fence (no full document)', () => {
    const { artifacts } = promote('Snippet:\n```html\n<div class="card"><p>hello</p></div>\n```\n');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].type).toBe('html');
  });

  it('promotes a full document inside a ```html fence exactly once (no double-wrap)', () => {
    const { artifacts, wrappers } = promote(
      '```html\n<!DOCTYPE html>\n<html><head><title>Full</title></head><body>x</body></html>\n```'
    );
    expect(artifacts).toHaveLength(1);
    expect(wrappers).toBe(1);
  });

  it('does not re-wrap an HTML document already inside an <artifact> tag', () => {
    const { artifacts, wrappers } = promote(
      '<artifact identifier="x" type="text/html" title="T">\n<!DOCTYPE html>\n<html><body>z</body></html>\n</artifact>'
    );
    expect(artifacts).toHaveLength(1);
    expect(wrappers).toBe(1);
  });

  it('leaves an HTML document inside a generic ``` code fence as a code block', () => {
    const { artifacts, wrappers } = promote('```\n<!DOCTYPE html>\n<html><body>q</body></html>\n```');
    expect(artifacts).toHaveLength(0);
    expect(wrappers).toBe(0);
  });

  it('does not promote prose that merely mentions HTML', () => {
    const { artifacts } = promote('We were discussing how to structure a document in this chat.');
    expect(artifacts).toHaveLength(0);
  });
});

/**
 * Small local models hallucinate a builder tool (e.g. build_html) and return the
 * artifact as tool-call JSON rather than an <artifact> tag or ```html fence. The
 * HTML in its arguments must be promoted, while ordinary JSON stays untouched.
 * Mirrors the twin suite in apps/client/app/utils/artifactParser.test.ts.
 */
describe('convertCodeBlocksToArtifacts - tool-call JSON promotion', () => {
  const promote = (input: string) => {
    const converted = convertCodeBlocksToArtifacts(input);
    const { artifacts } = parseArtifacts(converted);
    return { converted, artifacts };
  };

  const buildHtmlCall = (html: string) => JSON.stringify({ name: 'build_html', arguments: { html } });

  it('promotes a fenced build_html tool call to one text/html artifact', () => {
    const html = '<!DOCTYPE html><html><head><title>Snake</title></head><body><h1>Play</h1></body></html>';
    const { converted, artifacts } = promote('Here you go:\n```json\n' + buildHtmlCall(html) + '\n```');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].type).toBe('html');
    expect(artifacts[0].title).toBe('Snake');
    // The JSON is gone; only the surrounding prose survives outside the artifact.
    expect(converted).not.toContain('build_html');
    expect(converted).toContain('Here you go:');
  });

  it('preserves preamble prose around the promoted call', () => {
    const html = '<html><body><p>hi</p></body></html>';
    const { converted } = promote('Sure, building it now.\n```json\n' + buildHtmlCall(html) + '\n```\nEnjoy!');
    expect(converted).toContain('Sure, building it now.');
    expect(converted).toContain('Enjoy!');
    expect(converted).toContain('<artifact');
  });

  it('promotes an HTML fragment (no DOCTYPE) carried in the arguments', () => {
    const { artifacts } = promote('```tool_code\n' + buildHtmlCall('<div class="card"><p>hello</p></div>') + '\n```');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].type).toBe('html');
  });

  it('promotes other artifact-builder tool names (create_webpage) with a fragment', () => {
    const call = JSON.stringify({ name: 'create_webpage', arguments: { body: '<section><p>hi</p></section>' } });
    const { artifacts } = promote('```json\n' + call + '\n```');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].type).toBe('html');
  });

  it('leaves a legit tool whose args merely include HTML untouched (send_email)', () => {
    // Regression: a normal API-shaped answer must survive for all backends.
    const call = JSON.stringify({ name: 'send_email', arguments: { html_body: '<p>Hi</p>' } });
    const { artifacts, converted } = promote('```json\n' + call + '\n```');
    expect(artifacts).toHaveLength(0);
    expect(converted).toContain('send_email');
  });

  it('strips quotes from a model-controlled title so the artifact attribute is not truncated', () => {
    const html = '<!DOCTYPE html><html><head><title>Fish "Nemo" Tank</title></head><body><h1>Hi</h1></body></html>';
    const { artifacts } = promote('```json\n' + buildHtmlCall(html) + '\n```');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].type).toBe('html');
    expect(artifacts[0].title).toBe('Fish Nemo Tank');
  });

  it('promotes a bare tool-call object that is the entire reply', () => {
    const { artifacts } = promote(buildHtmlCall('<html><body>bare</body></html>'));
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].type).toBe('html');
  });

  it('leaves a non-tool-call JSON fence untouched', () => {
    const { artifacts, converted } = promote('```json\n{"foo":"bar","count":3}\n```');
    expect(artifacts).toHaveLength(0);
    expect(converted).toContain('"foo"');
  });

  it('leaves a tool-call-shaped JSON with no HTML untouched', () => {
    const { artifacts, converted } = promote('```json\n{"name":"math_evaluate","arguments":{"expression":"2+2"}}\n```');
    expect(artifacts).toHaveLength(0);
    expect(converted).toContain('math_evaluate');
  });

  it('leaves a legitimate JSON API example untouched', () => {
    const { artifacts } = promote('```json\n{"name":"Ada","parameters":{"age":36,"city":"Paris"}}\n```');
    expect(artifacts).toHaveLength(0);
  });
});

/**
 * Small local models sometimes stub out an image as an empty <svg> placeholder
 * (only a "goes here" comment) alongside a real generated image. parseArtifacts
 * faithfully extracts it, and it renders as a blank canvas. It must be suppressed.
 * Mirrors the twin suite in apps/client/app/utils/artifactParser.test.ts.
 */
describe('parseArtifacts - graphically-empty SVG suppression', () => {
  // The exact stub observed from qwen2.5-coder:7b on "generate fish image please".
  const placeholder = [
    '<artifact identifier="fish-image" type="image/svg+xml" title="Tropical Fish Illustration">',
    '  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600">',
    '    <!-- SVG content for the fish illustration goes here -->',
    '  </svg>',
    '</artifact>',
  ].join('\n');

  it('drops a placeholder SVG artifact (comment-only body) and strips its markup', () => {
    const { artifacts, cleanedContent } = parseArtifacts(placeholder);
    expect(artifacts).toHaveLength(0);
    expect(cleanedContent).not.toContain('<artifact');
    expect(cleanedContent).not.toContain('<svg');
  });

  it('keeps an SVG artifact that actually draws something', () => {
    const real =
      '<artifact identifier="fish" type="image/svg+xml" title="Fish">' +
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg>' +
      '</artifact>';
    const { artifacts } = parseArtifacts(real);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].type).toBe('svg');
  });

  it('isSvgGraphicallyEmpty flags comment/whitespace-only and self-closing roots', () => {
    expect(isSvgGraphicallyEmpty('<svg viewBox="0 0 8 6"><!-- x --></svg>')).toBe(true);
    expect(isSvgGraphicallyEmpty('<svg></svg>')).toBe(true);
    expect(isSvgGraphicallyEmpty('  <svg width="10" height="10"/>  ')).toBe(true);
    expect(isSvgGraphicallyEmpty('<svg><rect width="10" height="10"/></svg>')).toBe(false);
    expect(isSvgGraphicallyEmpty('<svg><text>hi</text></svg>')).toBe(false);
  });

  it('drops an empty svg but keeps a real svg in the same reply (mixed content)', () => {
    const realSvg =
      '<artifact identifier="real" type="image/svg+xml" title="Real">' +
      '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="5" cy="5" r="4"/></svg></artifact>';
    const { artifacts, cleanedContent } = parseArtifacts('Look:\n' + placeholder + '\n' + realSvg + '\nDone.');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].title).toBe('Real');
    expect(cleanedContent).toContain('Look:');
    expect(cleanedContent).toContain('Done.');
    expect(cleanedContent).not.toContain('Tropical Fish');
    expect(cleanedContent).not.toContain('<svg');
  });

  it('treats a whitespace-only svg body as empty', () => {
    const { artifacts } = parseArtifacts(
      '<artifact identifier="x" type="image/svg+xml" title="X"><svg viewBox="0 0 4 4">   </svg></artifact>'
    );
    expect(artifacts).toHaveLength(0);
  });
});

describe('parseArtifacts — multi-line and special-character opening tags', () => {
  it('parses an artifact whose opening tag spans multiple lines', () => {
    const input = [
      'Here is the code:',
      '<artifact',
      '  identifier="my-app"',
      '  type="application/vnd.ant.react"',
      '  title="My Application">',
      'export default function App() { return <div>Hi</div>; }',
      '</artifact>',
      'Enjoy!',
    ].join('\n');

    const { artifacts, cleanedContent } = parseArtifacts(input);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].title).toBe('My Application');
    expect(artifacts[0].type).toBe('react');
    expect(cleanedContent).not.toContain('<artifact');
    expect(cleanedContent).toContain('Enjoy!');
  });

  it('parses an artifact whose title contains ">"', () => {
    const input =
      '<artifact identifier="converter" type="application/vnd.ant.react" title="A -> B Converter">code here</artifact>';

    const { artifacts, cleanedContent } = parseArtifacts(input);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].title).toBe('A -> B Converter');
    expect(artifacts[0].content).toBe('code here');
    expect(cleanedContent).not.toContain('code here');
  });

  it('parses multiple artifacts when one has ">" in its title', () => {
    const input = [
      '<artifact identifier="a" type="application/vnd.ant.react" title="X > Y">code1</artifact>',
      'Some text between.',
      '<artifact identifier="b" type="text/html" title="Page">code2</artifact>',
    ].join('\n');

    const { artifacts, cleanedContent } = parseArtifacts(input);
    expect(artifacts).toHaveLength(2);
    // The internal sort (for index-safe removal) reverses order; check by title.
    const titles = artifacts.map(a => a.title);
    expect(titles).toContain('X > Y');
    expect(titles).toContain('Page');
    expect(cleanedContent).toContain('Some text between.');
    expect(cleanedContent).not.toContain('code1');
    expect(cleanedContent).not.toContain('code2');
  });
});
