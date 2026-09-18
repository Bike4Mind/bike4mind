import { describe, it, expect } from 'vitest';
import { convertCodeBlocksToArtifacts } from './artifactParser';
import { parseArtifacts, isSvgGraphicallyEmpty } from './artifactParser';

/**
 * Regression coverage for the artifact parser hardening (gaps B & C):
 * bare <!DOCTYPE>/<html> documents and ```html fragments must be promoted to
 * artifacts so raw HTML never leaks into the chat, while content that is already
 * tagged or inside a generic code fence must be left untouched.
 */
describe('convertCodeBlocksToArtifacts - HTML promotion', () => {
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

/**
 * ATTRIBUTE_REGEX used to stop the value capture at the first quote of either kind,
 * so a double-quoted value containing an apostrophe was silently truncated.
 */
describe('parseArtifacts - attribute values containing quotes', () => {
  it('keeps an apostrophe inside a double-quoted title', () => {
    const { artifacts } = parseArtifacts(
      `<artifact identifier="bobs-app" type="text/html" title="Bob's App"><p>hi</p></artifact>`
    );
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].title).toBe("Bob's App");
    expect(artifacts[0].identifier).toBe('bobs-app');
    expect(artifacts[0].type).toBe('html');
  });

  it('keeps double quotes inside a single-quoted value', () => {
    const { artifacts } = parseArtifacts(
      `<artifact identifier='x' type='text/html' title='A "quoted" phrase'><p>hi</p></artifact>`
    );
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].title).toBe('A "quoted" phrase');
  });

  it('does not accept mismatched opening and closing quotes', () => {
    // The unterminated double quote makes the whole opening tag unmatchable.
    const { artifacts } = parseArtifacts(
      `<artifact identifier="x" type="text/html" title="mismatched'><p>hi</p></artifact>`
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

  it('parses an artifact with single-quoted attribute values', () => {
    const input = "<artifact identifier='widget' type='text/html' title='My Widget'><p>hi</p></artifact>";

    const { artifacts } = parseArtifacts(input);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].title).toBe('My Widget');
    expect(artifacts[0].type).toBe('html');
  });

  it('parses a multi-line opening tag whose title contains ">"', () => {
    const input = [
      '<artifact',
      '  identifier="tool"',
      '  type="text/html"',
      '  title="A -> B Converter">',
      '<p>content</p>',
      '</artifact>',
    ].join('\n');

    const { artifacts } = parseArtifacts(input);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].title).toBe('A -> B Converter');
  });

  it('does not match an artifact with an unterminated quote containing ">"', () => {
    // Malformed: opening quote on title never closed. The new regex correctly
    // rejects this (the old one matched); documenting the behavior change.
    const input = '<artifact identifier="x" type="text/html" title="A -> B>content</artifact>';

    const { artifacts } = parseArtifacts(input);
    expect(artifacts).toHaveLength(0);
  });
});

/**
 * The fenced detectors match a fence on its own and check the promotion anchors in the
 * callback, so these cases pin the promotion decisions and the behaviour that changed
 * when the anchors moved out of the patterns. Mirrors the twin suite in apps/client/app/utils/artifactParser.test.ts,
 * except for the react-fence cases: that detector's promotion rules are not shared
 * between the two copies.
 */
describe('convertCodeBlocksToArtifacts - linear fence detectors', () => {
  const wrappers = (s: string) => (s.match(/<artifact /g) || []).length;
  const DOC = '<!DOCTYPE html>\n<html><head><title>Page</title></head><body><h1>Hi</h1></body></html>';

  it('promotes two adjacent html document fences as two artifacts', () => {
    const out = convertCodeBlocksToArtifacts('```html\n' + DOC + '\n```\n\n```html\n' + DOC + '\n```');
    expect(wrappers(out)).toBe(2);
    expect(out).not.toContain('```html');
  });

  it('promotes two adjacent svg fences as two artifacts', () => {
    const svg = '<svg viewBox="0 0 2 2"><rect width="1" height="1" /></svg>';
    const out = convertCodeBlocksToArtifacts('```svg\n' + svg + '\n```\n\n```svg\n' + svg + '\n```');
    expect(wrappers(out)).toBe(2);
    expect(out.match(/image\/svg\+xml/g)).toHaveLength(2);
  });

  it('leaves a ```svg fence with no closing </svg> as a code block', () => {
    const input = '```svg\n<svg viewBox="0 0 2 2"><rect width="1" height="1" />\n```';
    const out = convertCodeBlocksToArtifacts(input);
    expect(wrappers(out)).toBe(0);
    expect(out).toContain('```svg');
  });

  it('leaves a fence followed by a long whitespace run untouched, in bounded time', () => {
    // Greedy whitespace ahead of the lazy body group backtracks one character at a time
    // when the fence never closes, which is quadratic in the length of the run.
    for (const label of ['html', 'svg', 'tsx', 'json']) {
      const input = '```' + label + '\n' + '\n'.repeat(200000) + 'x';
      const startedAt = Date.now();
      expect(convertCodeBlocksToArtifacts(input)).toBe(input);
      expect(Date.now() - startedAt).toBeLessThan(1000);
    }
  });

  it('does not promote an svg fence whose closer precedes its opening tag', () => {
    const input = '```svg\n</svg>\n<svg viewBox="0 0 2 2">\n```';
    expect(convertCodeBlocksToArtifacts(input)).toBe(input);
  });

  it('falls a non-document html fence through to the fragment handler', () => {
    const out = convertCodeBlocksToArtifacts('```html\n<div class="card">hi</div>\n```');
    expect(wrappers(out)).toBe(1);
    expect(out).toContain('HTML Snippet');
  });

  it('does not promote an html fence whose closer precedes its doctype', () => {
    const out = convertCodeBlocksToArtifacts('```html\n</html>\n<!DOCTYPE html>\n<div>x</div>\n```');
    expect(wrappers(out)).toBe(1);
    expect(out).toContain('HTML Snippet');
    expect(out).not.toContain('HTML Page');
  });

  it('does not let a later fence promote an earlier one', () => {
    const out = convertCodeBlocksToArtifacts('```html\nnot markup at all\n```\n\n```html\n' + DOC + '\n```');
    expect(wrappers(out)).toBe(1);
    expect(out).toContain('```html\nnot markup at all\n```');
  });

  it('promotes a document whose lines are separated by \\r or U+2028', () => {
    // No <title>, so the document pass ('HTML Page') stays distinguishable from the
    // fragment fallback ('HTML Snippet'), which takes any ```html fence with an opening tag.
    const untitled = '<!DOCTYPE html>\n<html><body><h1>Hi</h1></body></html>';
    const cr = convertCodeBlocksToArtifacts('```html\r' + untitled.replace('\n', '\r') + '\r```');
    expect(wrappers(cr)).toBe(1);
    expect(cr).toContain('HTML Page');
    const ls = convertCodeBlocksToArtifacts('```html\n' + untitled.replace('\n', '\u2028') + '\n```');
    expect(wrappers(ls)).toBe(1);
    expect(ls).toContain('HTML Page');
  });

  it('leaves an unterminated react fence untouched, in bounded time', () => {
    // Same pathological shape as the html case: component markers present on many
    // lines, no closing fence. The old anchored pattern was quadratic in body size.
    const input = '```tsx\n' + 'const App = () => null; export default App;\n'.repeat(8000);
    const startedAt = Date.now();
    const out = convertCodeBlocksToArtifacts(input);
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(out).toBe(input);
  });

  it('drops a double quote from a promoted document title', () => {
    const doc = '<!DOCTYPE html>\n<html><head><title>a" type="text/plain</title></head><body>x</body></html>';
    for (const input of [doc, '```html\n' + doc + '\n```']) {
      const out = convertCodeBlocksToArtifacts(input);
      expect(out).toContain('type="text/html"');
      expect(out).toMatch(/title="a type=text\/plain"/);
    }
  });

  it('leaves an svg fence with no closing tag untouched, in bounded time', () => {
    // Openings with no closer: the shape that made a single <svg...</svg> predicate
    // re-scan the body from each one.
    const input = '```svg\n' + '<svg '.repeat(51200) + '\n```';
    const startedAt = Date.now();
    const out = convertCodeBlocksToArtifacts(input);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(out).toBe(input);
  });

  it('leaves a single-line react fence untouched, in bounded time', () => {
    // One line, no newlines to bound a per-keyword rescan, no component marker.
    const input = '```tsx\n' + 'const '.repeat(43000) + '\n```';
    const startedAt = Date.now();
    const out = convertCodeBlocksToArtifacts(input);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(out).toBe(input);
  });

  it('leaves unterminated html fences untouched, in bounded time', () => {
    // First body is the pathological shape for the old anchored pattern: both anchors
    // present, many candidate splits for its two lazy groups, no closing fence.
    const bodies = [
      '```html\n<!DOCTYPE html>\n' + '<html></html>\n'.repeat(16000),
      '```html\n<!DOCTYPE html>\n' + '<div>x</div>\n'.repeat(20000),
    ];
    for (const input of bodies) {
      const startedAt = Date.now();
      const out = convertCodeBlocksToArtifacts(input);
      expect(Date.now() - startedAt).toBeLessThan(2000);
      expect(out).toBe(input);
    }
  });
});

/**
 * promoteBareHtmlDocument is module-private and runs last inside
 * convertCodeBlocksToArtifacts, so these cases drive it through the public entry point.
 * MUST STAY IN SYNC with the twin suite in apps/client/app/utils/artifactParser.test.ts.
 */
describe('convertCodeBlocksToArtifacts - bare html document promotion', () => {
  const wrappers = (s: string) => (s.match(/<artifact /g) || []).length;
  const BARE = '<!DOCTYPE html>\n<html><head><title>Bare</title></head><body>hi</body></html>';

  it('promotes a bare document sitting in prose', () => {
    const out = convertCodeBlocksToArtifacts('Here you go:\n\n' + BARE + '\n\nEnjoy.');
    expect(wrappers(out)).toBe(1);
    expect(out).toContain('title="Bare"');
    expect(out).toContain('Here you go:');
    expect(out).toContain('Enjoy.');
  });

  it('promotes two bare documents in one message', () => {
    expect(wrappers(convertCodeBlocksToArtifacts(BARE + '\n---\n' + BARE))).toBe(2);
  });

  it('skips a document inside an open code fence or an open artifact tag', () => {
    expect(wrappers(convertCodeBlocksToArtifacts('```\n' + BARE))).toBe(0);
    const wrapped = '<artifact identifier="x" type="text/html" title="X">\n' + BARE + '\n</artifact>';
    expect(wrappers(convertCodeBlocksToArtifacts(wrapped))).toBe(1);
  });

  it('clears the fence guard for the document after the fence closes', () => {
    // The guards accumulate across matches instead of re-reading the whole prefix, so
    // the second document is what pins the carry from the first.
    const out = convertCodeBlocksToArtifacts('```\n' + BARE + '\n```\n\n' + BARE);
    expect(wrappers(out)).toBe(1);
    expect(out).toContain('```\n' + BARE + '\n```');
  });

  it('clears the artifact guard for the document after the wrapper closes', () => {
    const wrapped = '<artifact identifier="x" type="text/html" title="X">\n' + BARE + '\n</artifact>\n\n' + BARE;
    expect(wrappers(convertCodeBlocksToArtifacts(wrapped))).toBe(2);
  });

  it('stays bounded on many html openings, with and without closers', () => {
    // Each body is a shape that used to make this pass quadratic in message length:
    // many complete documents (guard re-read the whole prefix per match), openings that
    // never close (pattern re-scanned to end of input from each one), and the same
    // inside an unterminated fence.
    const bodies = [
      '<html></html>\n'.repeat(60000),
      '<html>\n'.repeat(60000),
      '```html\n<!DOCTYPE html>\n' + '<html></html>\n'.repeat(60000),
    ];
    for (const input of bodies) {
      const startedAt = Date.now();
      convertCodeBlocksToArtifacts(input);
      expect(Date.now() - startedAt).toBeLessThan(1500);
    }
  });
});
