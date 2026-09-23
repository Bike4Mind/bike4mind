import { describe, it, expect } from 'vitest';
import {
  convertCodeBlocksToArtifacts,
  parseArtifacts,
  isSvgGraphicallyEmpty,
  scanMermaidFences,
} from './artifactParser';

// The baseline-vs-SMALL_INPUT_MS_CEILING check below is the real regression guard: it
// fails fast instead of letting a hang run out the clock. The ratio check is secondary
// and, in practice, close to a fixed budget rather than a true ratio: every baseline
// measured here lands under this floor, so flooring the denominator reduces
// `ratio < GROWTH_RATIO_CEILING` to `doubledMs < GROWTH_RATIO_CEILING * MIN_BASELINE_MS`.
// The floor exists because a near-instant call is noise-dominated - without it, timer
// jitter alone could inflate the ratio past the ceiling.
const MIN_BASELINE_MS = 25;
// Headroom over linear scaling (~2x) while staying clear of quadratic (~4x) and cubic
// (~8x) - see MIN_BASELINE_MS above for why this is a secondary check in practice.
const GROWTH_RATIO_CEILING = 3;
// Generous on purpose: this only exists to catch a genuine wedge, not to pin steady-state timing.
const SMALL_INPUT_MS_CEILING = 500;

/**
 * Asserts near-linear scaling from `small` to `small * 2` input size, in place of a
 * fixed time budget: a budget only fails once the synchronous scan already returned,
 * so a real quadratic regression hangs the test runner instead of failing it. Both
 * sizes stay small enough to run fast even on a quadratic (or worse) implementation.
 */
function assertLinearGrowth(
  build: (n: number) => string,
  small: number,
  checkOutput: (out: string, input: string) => void = (out, input) => expect(out).toBe(input),
  run: (input: string) => string = convertCodeBlocksToArtifacts,
  minBaselineMs: number = MIN_BASELINE_MS
) {
  // Best of three, not a single timing: a GC pause landing in one measured window is
  // worth more than the whole budget here (the current parser needs single-digit
  // milliseconds), while a genuinely super-linear scan is slow on every attempt.
  const measure = (n: number) => {
    const input = build(n);
    let bestMs = Infinity;
    for (let attempt = 0; attempt < 3; attempt++) {
      const startedAt = performance.now();
      const out = run(input);
      bestMs = Math.min(bestMs, performance.now() - startedAt);
      if (attempt === 0) checkOutput(out, input);
    }
    return bestMs;
  };

  const baselineMs = measure(small);
  expect(baselineMs).toBeLessThan(SMALL_INPUT_MS_CEILING);

  const doubledMs = measure(small * 2);
  const ratio = doubledMs / Math.max(baselineMs, minBaselineMs);
  expect(ratio).toBeLessThan(GROWTH_RATIO_CEILING);
}

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

  it('leaves an unterminated comment in place, scaling linearly', () => {
    // Openings with no closer: the shape that made the old /<!--[\s\S]*?-->/g re-scan to
    // the end of the input from every one of them. Sized so pre-fix breaches the 500ms
    // small-input ceiling outright instead of a ratio a loaded runner's noise can flip:
    // measured in-suite on a quiet host, pre-fix breaches the ceiling by about 2.8x at
    // n=64000, against 0.90/1.79ms for the current scan; the raised floor below is belt
    // and braces.
    // Size this shape by running it IN the suite, not standalone: the same pre-fix call
    // runs slower standalone than it does here, because earlier tests have already
    // warmed the JIT, and sizing from the standalone figure would leave less headroom
    // over the ceiling.
    assertLinearGrowth(
      n => '<svg>' + '<!--'.repeat(n) + '</svg>',
      64000,
      out => expect(out).toBe('false'),
      input => String(isSvgGraphicallyEmpty(input)),
      150
    );
  });

  it('strips a closed comment but keeps an unterminated one', () => {
    expect(isSvgGraphicallyEmpty('<svg><!-- a --><!-- b --></svg>')).toBe(true);
    expect(isSvgGraphicallyEmpty('<svg><!-- a --><rect/></svg>')).toBe(false);
    // The unterminated opening is content, so the stub is not "empty".
    expect(isSvgGraphicallyEmpty('<svg><!-- a --><!-- b</svg>')).toBe(false);
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

  it('leaves a fence followed by a long whitespace run untouched, scaling linearly', () => {
    // Greedy whitespace ahead of the lazy body group backtracks one character at a time
    // when the fence never closes, which is quadratic in the length of the run.
    for (const label of ['html', 'svg', 'tsx', 'json', 'mermaid']) {
      // Sized so EVERY label fails on the 500ms ceiling pre-fix, not on the growth ratio:
      // the ratio's true quadratic value is 4.0 and the check is < 3, but a 30000-char run
      // costs four of these labels far less than a 180000-char one, and a MIN_BASELINE_MS
      // floor that low leaves a noisy baseline read enough room to pass against unfixed
      // code. Measured in-suite on a quiet host, pre-fix html breaches the 500ms ceiling
      // by about 9.3x at n=180000; the loop aborts on that first label, so the other
      // labels are not independently measured here - they are the same shape and the
      // same size, differing only in the fence label. The current parser needs a
      // millisecond or two either side, so the budget is really GC noise in the
      // measured window.
      // At this size the fixed parser's baseline is a fraction of a millisecond for four
      // of the five labels, so the ratio collapses into an absolute budget that measures
      // shared-runner noise; the real guard here is the 500ms small-input ceiling above,
      // which pre-fix code breaches several times over, so raise the floor for this call
      // only.
      assertLinearGrowth(
        n => '```' + label + '\n' + '\n'.repeat(n) + 'x',
        180000,
        (out, input) => expect(out).toBe(input),
        convertCodeBlocksToArtifacts,
        150
      );
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

  it('leaves an unterminated react fence untouched', () => {
    // Not a growth-ratio case: the fence never closes, so the react regex fails on its
    // first (and only) anchor attempt regardless of body size - measured linear on both
    // the pre-fix and current parser, so there is no old-vs-new gap to pin here.
    const input = '```tsx\n' + 'const App = () => null; export default App;\n'.repeat(1000);
    expect(convertCodeBlocksToArtifacts(input)).toBe(input);
  });

  it('drops a double quote from a promoted document title', () => {
    const doc = '<!DOCTYPE html>\n<html><head><title>a" type="text/plain</title></head><body>x</body></html>';
    for (const input of [doc, '```html\n' + doc + '\n```']) {
      const out = convertCodeBlocksToArtifacts(input);
      expect(out).toContain('type="text/html"');
      expect(out).toMatch(/title="a type=text\/plain"/);
    }
  });

  it('leaves an svg fence with no closing tag untouched', () => {
    // Output equality only, not a regression guard: this copy's hasCompleteSvg was
    // already a plain indexOf scan before the change (0.1ms at n=800, 0.9ms at n=25600),
    // so there is no old-vs-new gap to pin. The growth-ratio version of this case lives
    // in the twin client suite, whose pre-fix doubly-anchored <svg>...</svg> pattern
    // takes ~0.6s at n=400.
    const input = '```svg\n' + '<svg '.repeat(800) + '\n```';
    expect(convertCodeBlocksToArtifacts(input)).toBe(input);
  });

  it('leaves a single-line react fence untouched', () => {
    // Not a growth-ratio case: one line, no closing fence, and the react regex fails
    // its only anchor attempt regardless of body size - measured linear on both the
    // pre-fix and current parser.
    const input = '```tsx\n' + 'const '.repeat(8000) + '\n```';
    expect(convertCodeBlocksToArtifacts(input)).toBe(input);
  });

  it('leaves an unterminated html fence untouched, scaling linearly', () => {
    // Many <!DOCTYPE occurrences and no </html> anywhere, so the pre-fix bare-document
    // pattern re-scanned to the end of the input from each one. Sized so pre-fix breaches
    // the 500ms small-input ceiling outright instead of a ratio a loaded runner's noise
    // can flip: measured in-suite on a quiet host, pre-fix breaches the ceiling by about
    // 1.85x at n=28000 alone, current runs 0.5/1.0ms; the raised floor below is belt and
    // braces.
    assertLinearGrowth(
      n => '```html\n' + '<!DOCTYPE html>\n'.repeat(n),
      28000,
      (out, input) => expect(out).toBe(input),
      convertCodeBlocksToArtifacts,
      150
    );
  });

  it('leaves an unterminated html fence with no promotable markup untouched', () => {
    // Not a growth-ratio case: a single <!DOCTYPE anchor followed by many closed
    // <div> lines and no </html> ever. The old pattern still resolves this in one
    // linear pass (its anchor never repeats), so there is no old-vs-new gap to pin;
    // this instead just pins that a large, never-closing fence body is left alone.
    const input = '```html\n<!DOCTYPE html>\n' + '<div>x</div>\n'.repeat(3800);
    expect(convertCodeBlocksToArtifacts(input)).toBe(input);
  });

  // The mermaid fence body is the one that cannot simply drop its leading \s*: the old
  // body matched whole newline-terminated lines only, so the run of whitespace ahead of
  // it was load-bearing. These pin the match set the rewritten body has to keep.
  describe('mermaid fence body', () => {
    const LINE_SEPARATOR = String.fromCharCode(0x2028);

    it('promotes a body of newline-terminated lines', () => {
      const out = convertCodeBlocksToArtifacts('```mermaid\ngraph TD\n  A-->B\n```');
      expect(wrappers(out)).toBe(1);
      expect(out).toContain('type="application/vnd.ant.mermaid"');
    });

    it('promotes a fence opened with a CRLF break', () => {
      const out = convertCodeBlocksToArtifacts('```mermaid\r\ngraph TD\n  A-->B\n```');
      expect(wrappers(out)).toBe(1);
    });

    it('promotes a fence opened with a run of spaces before the break', () => {
      const out = convertCodeBlocksToArtifacts('```mermaid   \ngraph TD\n  A-->B\n```');
      expect(wrappers(out)).toBe(1);
    });

    it('leaves a body that does not end on a newline as a code block', () => {
      const input = '```mermaid\ngraph TD\n  A-->B```';
      expect(convertCodeBlocksToArtifacts(input)).toBe(input);
    });

    it('leaves a body with CR line endings as a code block', () => {
      const input = '```mermaid\r\ngraph TD\r\n  A-->B\r\n```';
      expect(convertCodeBlocksToArtifacts(input)).toBe(input);
    });

    it('leaves a body carrying a Unicode line separator as a code block', () => {
      const input = '```mermaid\ngraph TD' + LINE_SEPARATOR + '  A-->B\n```';
      expect(convertCodeBlocksToArtifacts(input)).toBe(input);
    });

    it('stays linear on a long run of mermaid openers that never close, scaling linearly', () => {
      // One opener every 11 characters and no closer anywhere: the old regex started a fresh
      // lazy scan to the end of the input from each one. Sized so pre-fix breaches the 500ms
      // small-input ceiling outright instead of a ratio a loaded runner's noise can flip:
      // measured in-suite on a quiet host, pre-fix breaches the ceiling by about 1.9x at
      // n=16000 alone; current runs 1.3ms and 2.3ms on this quiet host (the doubled side
      // is load-sensitive on a busier host, which is the whole reason the ratio is not
      // the guard here); the raised floor below is belt and braces.
      assertLinearGrowth(
        n => '```mermaidZ'.repeat(n),
        16000,
        (out, input) => expect(out).toBe(input),
        convertCodeBlocksToArtifacts,
        150
      );
    });
  });
});

/**
 * hasReactComponentLine requires the declaration keyword (function/const/class)
 * and the component marker (Component/App/export default) to sit on the SAME line -
 * that is the constraint the per-line scan exists to preserve (see its doc comment).
 */
describe('convertCodeBlocksToArtifacts - component declaration line gate', () => {
  it('promotes a closed tsx fence whose declaration keyword and marker share a line', () => {
    const codeContent = 'export default function App() { const [x, setX] = useState(0); return null; }';
    const out = convertCodeBlocksToArtifacts('```tsx\n' + codeContent + '\n```');
    const { artifacts } = parseArtifacts(out);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].type).toBe('react');
  });

  it('does not promote a tsx fence whose declaration keyword and marker are on different lines', () => {
    const codeContent = [
      'function helper() {',
      '  return doSomething();',
      '}',
      '// App component below',
      'export default helper;',
    ].join('\n');
    const input = '```tsx\n' + codeContent + '\n```';
    expect(convertCodeBlocksToArtifacts(input)).toBe(input);
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

  it('stays bounded on many html openings, with and without closers, scaling linearly', () => {
    // Each shape used to make this pass quadratic in message length: many complete
    // documents (guard re-read the whole prefix per match), openings that never close
    // (pattern re-scanned to end of input from each one), and many never-closing
    // openings inside an unterminated fence. This test only cares about growth, not
    // the output shape (the first two get promoted, the third stays a code block
    // since its fence never closes), so it skips the output equality check.
    // Sized (as with the long-whitespace-run test above) so pre-fix code breaches the
    // 500ms small-input ceiling outright instead of tripping a ratio: at a small size
    // where pre-fix is merely slow, the current parser's own cost is a few milliseconds,
    // so an unraised floor turns the ratio into an absolute ~75ms budget on the doubled
    // run that a loaded shared runner can miss on noise alone. Measured in-suite on a
    // quiet host, pre-fix core breaches the ceiling by about 2.2x at n=28000 alone on
    // the first shape (the call aborts at the first shape, so the other two sizes are
    // not independently measured here), against 4.7/10.6ms, 0.5/0.9ms and 0.5/1.0ms
    // now. The first shape promotes every document, so its output allocation dominates
    // and its cost swings with host load, which is the reading the raised floor stops
    // the ratio from turning into a verdict now that the ceiling is the real guard.
    const noOutputCheck = () => {};
    assertLinearGrowth(n => '<html></html>\n'.repeat(n), 28000, noOutputCheck, convertCodeBlocksToArtifacts, 150);
    assertLinearGrowth(n => '<html>\n'.repeat(n), 32000, noOutputCheck, convertCodeBlocksToArtifacts, 150);
    assertLinearGrowth(
      n => '```html\n' + '<!DOCTYPE html>\n'.repeat(n),
      22000,
      noOutputCheck,
      convertCodeBlocksToArtifacts,
      150
    );
  });
});

describe('convertCodeBlocksToArtifacts - linear rewrite of the fenced-code detectors', () => {
  const F = '```';

  it('promotes adjacent code blocks independently without merging them', () => {
    // The pre-rewrite regexes over-matched past the first closing fence, swallowing
    // a following block into one malformed artifact. Each block must now convert on
    // its own.
    const input = `first\n${F}tsx\nexport default function App() { return <i/>; }\n${F}\nmid\n${F}svg\n<svg><rect/></svg>\n${F}\nlast`;
    const out = convertCodeBlocksToArtifacts(input);

    const { artifacts } = parseArtifacts(out);
    expect(artifacts).toHaveLength(2);
    expect(artifacts.map(a => a.type).sort()).toEqual(['react', 'svg']);
    // The literal fence delimiters must be gone (fully consumed by the two conversions).
    expect(out).not.toContain(F);
  });

  it('completes on an unterminated code fence without catastrophic backtracking', () => {
    // The anchor has to MATCH on many lines for the pre-rewrite
    // `(?:.*\n)*?ANCHOR(?:\n.*)*?` shape to enter its rescan - on a body where no line
    // satisfies it, the old regex was already linear and this input proved nothing.
    // `const App` satisfies it on every line: measured against the old shape the cost is
    // ~4x per doubling (210ms at 2k lines, 822ms at 4k, ~3.3s at 8k). Linear now, so this
    // returns immediately and a revert blows the budget below.
    const adversarial = `${F}tsx\n` + 'const App = 1\n'.repeat(8_000);
    const started = Date.now();
    const out = convertCodeBlocksToArtifacts(adversarial);
    // No closing fence, so neither fence regex matches: left untouched.
    expect(out).toBe(adversarial);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('still promotes a React component and still leaves a non-component fence alone', () => {
    const promoted = convertCodeBlocksToArtifacts(`${F}tsx\nexport default function App() { return <i/>; }\n${F}`);
    expect(promoted).toContain('type="application/vnd.ant.react"');

    // `const Widget` has a declaration but no component token after it on the line, so
    // it is not promoted even though it uses hooks - preserving prior behavior.
    const plain = `${F}jsx\nconst Widget = () => {\n  const [x] = useState(0);\n  return <p>{x}</p>;\n};\n${F}`;
    expect(convertCodeBlocksToArtifacts(plain)).toBe(plain);
  });
});

/**
 * The mermaid fence is the one detector found by an index scan instead of a regex, so the regex
 * it replaced is the oracle for its match set: anything the scanner finds, drops or spans
 * differently is a behavior change. Two oracles, both run by the differential below:
 * `mainMermaidFence` is the literal shipped on main, and `originalMermaidFence` is the tightened
 * equivalent this branch carried before the scanner replaced it.
 */
const mainMermaidFence = () => /```mermaid\s*((?:.*\n)*?)```/gi;
const originalMermaidFence = () => /```mermaid\s*((?:\S(?:.|\n)*?\n)??)```/gi;

/**
 * The same pattern with the body's `(?:.|\n)` widened to `[\s\S]`, which drops exactly the
 * constraint the scanner's break-character rule keeps. Stand-in for a scanner without that rule.
 */
const mermaidFenceWithoutBreakRule = () => /```mermaid\s*((?:\S[\s\S]*?\n)??)```/gi;

/**
 * One record per match: span plus the captured body. The RegExp is rebuilt per input by every
 * caller below, never shared: a `/gi` object carries `lastIndex` across inputs, and a leaked one
 * reports no match at all on the next input, which reads as an over-match by the scanner.
 */
function fenceRecords(re: RegExp, source: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    out.push(JSON.stringify([m.index, m.index + m[0].length, m[1]]));
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

const scannerRecords = (source: string): string[] =>
  scanMermaidFences(source).map(f => JSON.stringify([f.start, f.end, f.body]));

interface Directions {
  /** Oracle matches the implementation under test did not produce. */
  missing: number;
  /** Matches the implementation produced that the oracle does not have. */
  extra: number;
  examples: string[];
}

function compareFences(expected: string[], actual: string[], source: string, into: Directions): void {
  const missing = expected.filter(r => !actual.includes(r));
  const extra = actual.filter(r => !expected.includes(r));
  into.missing += missing.length;
  into.extra += extra.length;
  if ((missing.length || extra.length) && into.examples.length < 5) {
    into.examples.push(`${JSON.stringify(source)} missing=${missing.join('')} extra=${extra.join('')}`);
  }
}

/** Deterministic LCG (Numerical Recipes constants) so CI generates the identical corpus every run. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/**
 * Pieces the generator splices into fence-shaped cases. The three characters the old body could
 * not cross are in here alone and glued to a closer, since they are the point of the differential.
 */
const FENCE_ATOMS: readonly string[] = [
  '`',
  '``',
  '```',
  '````',
  'm',
  'M',
  'e',
  'r',
  'a',
  'i',
  'd',
  'Z',
  '-',
  '>',
  'mermaid',
  'MERMAID',
  'Mermaid',
  'mermai',
  'ermaid',
  '\n',
  '\r',
  '\r\n',
  '\t',
  ' ',
  '  ',
  String.fromCharCode(0x2028),
  String.fromCharCode(0x2029),
  '```mermaid',
  '```mermaid\n',
  '\n```',
  'graph TD',
  'A-->B',
  '',
  String.fromCharCode(0x2028) + '```',
  '\r\n```',
  '```\n',
];

const FENCE_CORPUS: readonly string[] = (() => {
  const build = (count: number, seed: number, maxAtoms: number): string[] => {
    const rand = lcg(seed);
    const cases: string[] = [];
    for (let i = 0; i < count; i++) {
      const atoms = 1 + Math.floor(rand() * maxAtoms);
      let text = '';
      for (let j = 0; j < atoms; j++) text += FENCE_ATOMS[Math.floor(rand() * FENCE_ATOMS.length)];
      cases.push(text);
    }
    return cases;
  };
  // Two lengths: the short cases concentrate opener/closer/break interactions, the long ones
  // reach the multi-fence paths where a rejected fence still has to leave both cursors usable.
  return [...build(20000, 0x5eed1234, 14), ...build(4000, 0xc0ffee, 40)];
})();

// scanMermaidFences as it stood before its fence-free probe was hoisted in front of the two
// index builds. Verbatim apart from its own regex instance, which keeps this copy from
// disturbing the module-scoped lastIndex the real scanner shares across calls.
const UNHOISTED_FENCE_OPEN = /```mermaid/gi;

function scanMermaidFencesUnhoisted(source: string): { start: number; end: number; body: string }[] {
  const isBodyBreak = (code: number) => code === 0x0d || code === 0x2028 || code === 0x2029;
  const closers: number[] = [];
  for (let at = source.indexOf('\n```'); at !== -1; at = source.indexOf('\n```', at + 1)) closers.push(at);
  const breaks: number[] = [];
  for (let at = 0; at < source.length; at++) if (isBodyBreak(source.charCodeAt(at))) breaks.push(at);

  const fences: { start: number; end: number; body: string }[] = [];
  let closerAt = 0;
  let breakAt = 0;
  UNHOISTED_FENCE_OPEN.lastIndex = 0;
  for (let open = UNHOISTED_FENCE_OPEN.exec(source); open; open = UNHOISTED_FENCE_OPEN.exec(source)) {
    const start = open.index;
    let body = start + open[0].length;
    while (body < source.length && /\s/.test(source[body])) body++;
    if (source.startsWith('```', body)) {
      fences.push({ start, end: body + 3, body: '' });
      UNHOISTED_FENCE_OPEN.lastIndex = body + 3;
      continue;
    }
    while (closerAt < closers.length && closers[closerAt] <= body) closerAt++;
    if (closerAt === closers.length) continue;
    while (breakAt < breaks.length && breaks[breakAt] < body) breakAt++;
    const close = closers[closerAt];
    if (breakAt < breaks.length && breaks[breakAt] < close) continue;
    fences.push({ start, end: close + 4, body: source.slice(body, close + 1) });
    UNHOISTED_FENCE_OPEN.lastIndex = close + 4;
  }
  return fences;
}

describe('scanMermaidFences - fence-free fast path', () => {
  it('returns what the unhoisted scanner returned, over the corpus and on a repeat pass', () => {
    // Twice over: the real scanner's opener regex is module-scoped and /g, so a probe that
    // left lastIndex behind would only start dropping matches from the second call onwards.
    const extra = [
      '',
      'prose with no fence at all\nand a second line\n',
      'x'.repeat(4000),
      '```mermaid\nnever closes',
      '```mermaid\nA\n```\n```mermaid\nnever closes',
      '```mermaid\nA\n``````mermaid\n```',
    ];
    for (let pass = 0; pass < 2; pass++) {
      for (const source of [...FENCE_CORPUS, ...extra]) {
        expect({ pass, source, fences: scanMermaidFences(source) }).toEqual({
          pass,
          source,
          fences: scanMermaidFencesUnhoisted(source),
        });
      }
    }
  });

  it('skips the closer and body-break index builds when there is no mermaid fence', () => {
    // Same body either way, so the gap is the two index passes alone: measured ~50x with the
    // probe hoisted and ~1.3x without it, which puts this threshold far outside timer noise.
    const body = 'lorem ipsum dolor sit amet, consectetur adipiscing elit\n'.repeat(24000);
    const opened = body + '```mermaid\nx';
    const best = (source: string) => {
      let bestMs = Infinity;
      for (let attempt = 0; attempt < 9; attempt++) {
        const startedAt = performance.now();
        scanMermaidFences(source);
        bestMs = Math.min(bestMs, performance.now() - startedAt);
      }
      return bestMs;
    };

    expect(scanMermaidFences(body)).toEqual([]);
    expect(scanMermaidFences(opened)).toEqual([]);
    expect(best(body) * 4).toBeLessThan(best(opened));
  });
});

describe('scanMermaidFences differential vs the pre-change regexes', () => {
  it.each([
    ['the regex shipped on main', mainMermaidFence],
    ['the tightened form this branch replaced', originalMermaidFence],
  ])('reproduces every match of %s, and produces no match it did not have', (_label, oracle) => {
    const fences: Directions = { missing: 0, extra: 0, examples: [] };
    for (const source of FENCE_CORPUS) {
      compareFences(fenceRecords(oracle(), source), scannerRecords(source), source, fences);
    }
    expect(fences).toEqual({ missing: 0, extra: 0, examples: [] });
  });

  it('exercises the corpus rather than passing vacuously', () => {
    const withMatches = FENCE_CORPUS.filter(s => scanMermaidFences(s).length > 0).length;
    expect(withMatches).toBeGreaterThan(3000);
  });

  it('matches a body that is one unbroken run, which a leaked lastIndex hides', () => {
    // This input is why the oracle is rebuilt per case: a shared `/gi` whose lastIndex was left
    // past 35 by the previous case returns nothing here, and the difference reads as the
    // scanner inventing a match. Both sides agree; only the leak disagreed.
    const source = ' graph TD  ```MERMAIDmermaid ``\n```';
    expect(scannerRecords(source)).toEqual(fenceRecords(mainMermaidFence(), source));
    expect(scannerRecords(source)).toEqual(fenceRecords(originalMermaidFence(), source));
    expect(scanMermaidFences(source)).toEqual([{ start: 11, end: 35, body: 'mermaid ``\n' }]);
  });
});

/**
 * Control: the characters `(?:.|\n)` leaves out of the body. Widening it to `[\s\S]` lets a body
 * run across a CR or a Unicode separator and reach a closer the original never could - the
 * over-match the scanner's break-character rule exists to refuse.
 */
describe('mutation control: the body characters the original regex could not cross', () => {
  it('reaches a closer past a CR that neither the original nor the scanner accepts', () => {
    const source = '```mermaidgraph\r\nTD\n```';
    expect(fenceRecords(mainMermaidFence(), source)).toEqual([]);
    expect(fenceRecords(originalMermaidFence(), source)).toEqual([]);
    expect(scanMermaidFences(source)).toEqual([]);
    expect(fenceRecords(mermaidFenceWithoutBreakRule(), source)).toHaveLength(1);
  });

  it('diverges from the original regex and from the scanner, so the differential can fail', () => {
    const vsOriginal: Directions = { missing: 0, extra: 0, examples: [] };
    const vsScanner: Directions = { missing: 0, extra: 0, examples: [] };
    for (const source of FENCE_CORPUS) {
      const widened = fenceRecords(mermaidFenceWithoutBreakRule(), source);
      compareFences(fenceRecords(originalMermaidFence(), source), widened, source, vsOriginal);
      compareFences(scannerRecords(source), widened, source, vsScanner);
    }
    expect(vsOriginal.extra).toBeGreaterThan(1000);
    expect(vsScanner.extra).toBeGreaterThan(1000);
  });
});
