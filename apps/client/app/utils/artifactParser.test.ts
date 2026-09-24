import { beforeAll, describe, it, expect } from 'vitest';
import {
  convertCodeBlocksToArtifacts as coreConvertCodeBlocksToArtifacts,
  parseArtifacts as coreParseArtifacts,
} from '@bike4mind/utils/artifactParser';
import {
  convertCodeBlocksToArtifacts,
  extractReactDependencies,
  hasCompleteOpeningTag,
  hasSelfClosingTag,
  parseArtifactsWithFallback,
  isSvgGraphicallyEmpty,
  shouldWarnElidedArtifact,
  elidedReplyWarning,
  validateArtifactContent,
} from './artifactParser';

const STALE = 'core dist is stale - run pnpm turbo:core:build (or --force if that reports FULL TURBO)';

// Everything in this file reaches @bike4mind/utils, which resolves to b4m-core/utils/dist
// rather than source - the client parser imports stripHtmlComments, hasFullHtmlDocument and
// hasCompleteSvg from it. A dist predating those exports does not fail to link: vitest hands
// the importer `undefined` for each missing name, so the first suite to call one dies with
// `TypeError: stripHtmlComments is not a function` pointing at client source, and ~20 further
// suites follow, none of them naming the real cause. Checking the export surface once, up
// front, turns that into a single attributable failure.
beforeAll(async () => {
  const core: Record<string, unknown> = await import('@bike4mind/utils/artifactParser');
  for (const name of ['stripHtmlComments', 'hasFullHtmlDocument', 'hasCompleteSvg']) {
    expect(typeof core[name], `${STALE} (missing export: ${name})`).toBe('function');
  }
});

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

describe('extractReactDependencies', () => {
  it('detects packages imported via multi-line named imports', () => {
    // Mixes a single-line import with two consecutive multi-line destructured
    // imports. The old `.*?` regex (no dotAll) only caught the single-line one,
    // dropping recharts/lodash and causing `Module "recharts" is not available`.
    const content = [
      "import React, { useState } from 'react';",
      'import {',
      '  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer',
      "} from 'recharts';",
      'import {',
      '  debounce,',
      '  throttle',
      "} from 'lodash';",
      '',
      'export default function App() {',
      '  const [v, setV] = useState(0);',
      '  return <LineChart data={[]} />;',
      '}',
    ].join('\n');

    const deps = extractReactDependencies(content);

    // Each consecutive multi-line import must terminate at its own `from`
    // (guards the lazy `[\s\S]*?` against swallowing across statements).
    expect(deps).toContain('react');
    expect(deps).toContain('recharts');
    expect(deps).toContain('lodash');
  });
});

describe('parseArtifactsWithFallback', () => {
  const htmlDoc =
    '<!DOCTYPE html><html lang="en"><head><title>Night Markets</title></head><body><h1>Hi</h1></body></html>';

  it('promotes a bare HTML document with no explicit artifact tags', () => {
    const result = parseArtifactsWithFallback(`Here's your article:\n\n${htmlDoc}`);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].type).toBe('html');
    expect(result.artifacts[0].content).toContain('<!DOCTYPE html>');
    // The promoted document is stripped from the prose left for markdown rendering.
    expect(result.cleanedContent).not.toContain('<!DOCTYPE html>');
  });

  it('promotes a bare HTML document even when an explicit artifact is also present', () => {
    const explicit = '<artifact identifier="notes" type="text/markdown" title="Notes">some notes</artifact>';
    const result = parseArtifactsWithFallback(`${explicit}\n\nAnd the article:\n\n${htmlDoc}`);
    // Both the explicit artifact and the promoted HTML document survive the merge.
    expect(result.artifacts).toHaveLength(2);
    expect(result.artifacts.some(a => a.type === 'html')).toBe(true);
    expect(result.artifacts.some(a => a.title === 'Notes')).toBe(true);
  });

  it('leaves a plain reply with no promotable content untouched', () => {
    const result = parseArtifactsWithFallback('Just a normal answer with no code or HTML.');
    expect(result.artifacts).toHaveLength(0);
    expect(result.cleanedContent).toBe('Just a normal answer with no code or HTML.');
  });

  it('parses an artifact whose opening tag spans multiple lines', () => {
    const input = [
      'Here is the app:',
      '<artifact',
      '  identifier="app"',
      '  type="application/vnd.ant.react"',
      '  title="My App">',
      'export default function App() { return <div>Hello</div>; }',
      '</artifact>',
    ].join('\n');

    const result = parseArtifactsWithFallback(input);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].title).toBe('My App');
    expect(result.artifacts[0].type).toBe('react');
    expect(result.cleanedContent).not.toContain('<artifact');
  });

  it('parses an artifact whose title contains ">"', () => {
    const input =
      '<artifact identifier="tool" type="application/vnd.ant.react" title="React -> Next.js Migrator">code</artifact>';

    const result = parseArtifactsWithFallback(input);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].title).toBe('React -> Next.js Migrator');
    expect(result.cleanedContent).not.toContain('code');
  });

  it('does not duplicate artifacts when cleanedContent is empty and body contains a fenced code block', () => {
    // When the entire input is a single artifact whose body contains a ```tsx
    // fence, the old || fallback re-ran convertCodeBlocksToArtifacts on the
    // original content, double-emitting the inner code block as a second artifact.
    const input = [
      '<artifact identifier="app" type="application/vnd.ant.react" title="App">',
      '```tsx',
      'export default function Inner() { return <div/>; }',
      '```',
      '</artifact>',
    ].join('\n');

    const result = parseArtifactsWithFallback(input);
    expect(result.artifacts).toHaveLength(1);
  });

  it('parses an artifact with single-quoted attribute values', () => {
    const input = "<artifact identifier='widget' type='application/vnd.ant.react' title='My Widget'>code</artifact>";

    const result = parseArtifactsWithFallback(input);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].title).toBe('My Widget');
  });

  it('parses a multi-line opening tag whose title contains ">"', () => {
    const input = [
      '<artifact',
      '  identifier="converter"',
      '  type="application/vnd.ant.react"',
      '  title="A -> B Converter">',
      'export default function App() { return <div/>; }',
      '</artifact>',
    ].join('\n');

    const result = parseArtifactsWithFallback(input);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].title).toBe('A -> B Converter');
  });

  it('does not match an artifact with an unterminated quote containing ">"', () => {
    // Malformed input: the opening quote on title is never closed.
    // The new regex correctly rejects this (the old one matched, leaking
    // broken HTML); documenting the intentional change in behavior.
    const input = '<artifact identifier="x" type="text/html" title="A -> B>content</artifact>';

    const result = parseArtifactsWithFallback(input);
    expect(result.artifacts).toHaveLength(0);
  });
});

describe('hasCompleteOpeningTag', () => {
  it('returns true for a well-formed single-line opening tag', () => {
    expect(hasCompleteOpeningTag('<artifact identifier="x" type="text/html" title="Page">')).toBe(true);
  });

  it('returns true for an opening tag with ">" inside a quoted attribute', () => {
    expect(hasCompleteOpeningTag('<artifact identifier="x" type="text/html" title="A -> B">')).toBe(true);
  });

  it('returns false when the opening tag is truncated mid-attribute', () => {
    expect(hasCompleteOpeningTag('<artifact identifier="x" type="text/ht')).toBe(false);
  });

  it('returns false for a truncated tag with an unterminated quote containing ">"', () => {
    // Old regex [^>]* would see the > inside the unterminated quote and
    // return true, leaking broken HTML. The fixed pattern correctly rejects it.
    expect(hasCompleteOpeningTag('<artifact identifier="x" title="A -> B')).toBe(false);
  });

  it('returns true for a multi-line opening tag', () => {
    const tag = ['<artifact', '  identifier="app"', '  type="application/vnd.ant.react"', '  title="My App">'].join(
      '\n'
    );
    expect(hasCompleteOpeningTag(tag)).toBe(true);
  });
});

/**
 * Small local models hallucinate a builder tool (e.g. build_html) and return the
 * artifact as tool-call JSON rather than an <artifact> tag or ```html fence. The
 * HTML in its arguments must be promoted, while ordinary JSON stays untouched.
 * Mirrors the twin suite in b4m-core/utils/src/artifactParser.test.ts.
 */
describe('parseArtifactsWithFallback - tool-call JSON promotion', () => {
  const buildHtmlCall = (html: string) => JSON.stringify({ name: 'build_html', arguments: { html } });

  it('promotes a fenced build_html tool call to one text/html artifact', () => {
    const html = '<!DOCTYPE html><html><head><title>Snake</title></head><body><h1>Play</h1></body></html>';
    const result = parseArtifactsWithFallback('Here you go:\n```json\n' + buildHtmlCall(html) + '\n```');
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].type).toBe('html');
    expect(result.artifacts[0].title).toBe('Snake');
    // The JSON is gone; only the surrounding prose survives.
    expect(result.cleanedContent).not.toContain('build_html');
    expect(result.cleanedContent).toContain('Here you go:');
  });

  it('preserves preamble prose around the promoted call', () => {
    const html = '<html><body><p>hi</p></body></html>';
    const result = parseArtifactsWithFallback(
      'Sure, building it now.\n```json\n' + buildHtmlCall(html) + '\n```\nEnjoy!'
    );
    expect(result.artifacts).toHaveLength(1);
    expect(result.cleanedContent).toContain('Sure, building it now.');
    expect(result.cleanedContent).toContain('Enjoy!');
  });

  it('promotes an HTML fragment (no DOCTYPE) carried in the arguments', () => {
    const result = parseArtifactsWithFallback(
      '```tool_code\n' + buildHtmlCall('<div class="card"><p>hello</p></div>') + '\n```'
    );
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].type).toBe('html');
  });

  it('promotes other artifact-builder tool names (create_webpage) with a fragment', () => {
    const call = JSON.stringify({ name: 'create_webpage', arguments: { body: '<section><p>hi</p></section>' } });
    const result = parseArtifactsWithFallback('```json\n' + call + '\n```');
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].type).toBe('html');
  });

  it('leaves a legit tool whose args merely include HTML untouched (send_email)', () => {
    // Regression: a normal API-shaped answer must survive for all backends.
    const call = JSON.stringify({ name: 'send_email', arguments: { html_body: '<p>Hi</p>' } });
    const result = parseArtifactsWithFallback('```json\n' + call + '\n```');
    expect(result.artifacts).toHaveLength(0);
  });

  it('strips quotes from a model-controlled title so the artifact attribute is not truncated', () => {
    const html = '<!DOCTYPE html><html><head><title>Fish "Nemo" Tank</title></head><body><h1>Hi</h1></body></html>';
    const result = parseArtifactsWithFallback('```json\n' + buildHtmlCall(html) + '\n```');
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].type).toBe('html');
    expect(result.artifacts[0].title).toBe('Fish Nemo Tank');
  });

  it('promotes a bare tool-call object that is the entire reply', () => {
    const result = parseArtifactsWithFallback(buildHtmlCall('<html><body>bare</body></html>'));
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].type).toBe('html');
  });

  it('leaves a non-tool-call JSON fence untouched', () => {
    const result = parseArtifactsWithFallback('```json\n{"foo":"bar","count":3}\n```');
    expect(result.artifacts).toHaveLength(0);
  });

  it('leaves a tool-call-shaped JSON with no HTML untouched', () => {
    const result = parseArtifactsWithFallback(
      '```json\n{"name":"math_evaluate","arguments":{"expression":"2+2"}}\n```'
    );
    expect(result.artifacts).toHaveLength(0);
  });

  it('leaves a legitimate JSON API example untouched', () => {
    const result = parseArtifactsWithFallback('```json\n{"name":"Ada","parameters":{"age":36,"city":"Paris"}}\n```');
    expect(result.artifacts).toHaveLength(0);
  });
});

/**
 * A small local model stubs out an image as an empty <svg> placeholder alongside a
 * real generated image; it renders as a blank canvas and must be suppressed.
 * Mirrors the twin suite in b4m-core/utils/src/artifactParser.test.ts.
 */
describe('parseArtifactsWithFallback - graphically-empty SVG suppression', () => {
  // The exact stub observed from qwen2.5-coder:7b on "generate fish image please".
  const placeholder = [
    '<artifact identifier="fish-image" type="image/svg+xml" title="Tropical Fish Illustration">',
    '  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600">',
    '    <!-- SVG content for the fish illustration goes here -->',
    '  </svg>',
    '</artifact>',
  ].join('\n');

  it('drops a placeholder SVG artifact (comment-only body) and strips its markup', () => {
    const { artifacts, cleanedContent } = parseArtifactsWithFallback(placeholder);
    expect(artifacts).toHaveLength(0);
    expect(cleanedContent).not.toContain('<artifact');
    expect(cleanedContent).not.toContain('<svg');
  });

  it('keeps an SVG artifact that actually draws something', () => {
    const real =
      '<artifact identifier="fish" type="image/svg+xml" title="Fish">' +
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg>' +
      '</artifact>';
    const { artifacts } = parseArtifactsWithFallback(real);
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
    // measured in-suite on a quiet host, pre-fix breaches the ceiling by about 3.13x at
    // n=68000 alone; current runs 0.9/1.9ms. The raised floor below is belt and braces.
    assertLinearGrowth(
      n => '<svg>' + '<!--'.repeat(n) + '</svg>',
      68000,
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
    const { artifacts, cleanedContent } = parseArtifactsWithFallback(
      'Look:\n' + placeholder + '\n' + realSvg + '\nDone.'
    );
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].title).toBe('Real');
    expect(cleanedContent).toContain('Look:');
    expect(cleanedContent).toContain('Done.');
    expect(cleanedContent).not.toContain('Tropical Fish');
    expect(cleanedContent).not.toContain('<svg');
  });

  it('treats a whitespace-only svg body as empty', () => {
    const { artifacts } = parseArtifactsWithFallback(
      '<artifact identifier="x" type="image/svg+xml" title="X"><svg viewBox="0 0 4 4">   </svg></artifact>'
    );
    expect(artifacts).toHaveLength(0);
  });
});

/**
 * ATTRIBUTE_REGEX used to stop the value capture at the first quote of either kind,
 * so a double-quoted value containing an apostrophe was silently truncated.
 */
describe('parseArtifactsWithFallback - attribute values containing quotes', () => {
  it('keeps an apostrophe inside a double-quoted title', () => {
    const result = parseArtifactsWithFallback(
      `<artifact identifier="bobs-app" type="text/html" title="Bob's App"><p>hi</p></artifact>`
    );
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].title).toBe("Bob's App");
    expect(result.artifacts[0].identifier).toBe('bobs-app');
  });

  it('keeps double quotes inside a single-quoted value', () => {
    const result = parseArtifactsWithFallback(
      `<artifact identifier='x' type='text/html' title='A "quoted" phrase'><p>hi</p></artifact>`
    );
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].title).toBe('A "quoted" phrase');
  });

  it('does not accept mismatched opening and closing quotes', () => {
    // The unterminated double quote makes the whole opening tag unmatchable.
    const result = parseArtifactsWithFallback(
      `<artifact identifier="x" type="text/html" title="mismatched'><p>hi</p></artifact>`
    );
    expect(result.artifacts).toHaveLength(0);
  });
});

/**
 * The elision notice's decision logic. Mirrors how hasCompleteOpeningTag is tested above:
 * PromptReplies renders the banner, this decides whether it should.
 */
describe('shouldWarnElidedArtifact', () => {
  const ELIDED = {
    content: '<html><body><script>// ... (same JS as before)\nfunction init(){} init();</script></body></html>',
    type: 'html' as const,
  };
  const COMPLETE = {
    content: '<html><body><script>function init(){ document.title = "x"; } init();</script></body></html>',
    type: 'html' as const,
  };

  it('warns on a completed reply whose artifact body is stubbed', () => {
    expect(
      shouldWarnElidedArtifact({
        completed: true,
        isTruncatedArtifact: false,
        suspectedElision: false,
        artifacts: [ELIDED],
      })
    ).toBe(true);
  });

  it('stays silent for a complete artifact', () => {
    expect(
      shouldWarnElidedArtifact({
        completed: true,
        isTruncatedArtifact: false,
        suspectedElision: false,
        artifacts: [COMPLETE],
      })
    ).toBe(false);
  });

  it('defers to the truncation banner rather than stacking two warnings', () => {
    expect(
      shouldWarnElidedArtifact({
        completed: true,
        isTruncatedArtifact: true,
        suspectedElision: true,
        artifacts: [ELIDED],
      })
    ).toBe(false);
  });

  it('stays silent while the reply is still streaming', () => {
    expect(
      shouldWarnElidedArtifact({
        completed: false,
        isTruncatedArtifact: false,
        suspectedElision: true,
        artifacts: [ELIDED],
      })
    ).toBe(false);
  });

  it("trusts the server's verdict even when the local scan finds nothing", () => {
    expect(
      shouldWarnElidedArtifact({
        completed: true,
        isTruncatedArtifact: false,
        suspectedElision: true,
        artifacts: [COMPLETE],
      })
    ).toBe(true);
  });

  it('warns when any one of several artifacts is stubbed', () => {
    expect(
      shouldWarnElidedArtifact({
        completed: true,
        isTruncatedArtifact: false,
        suspectedElision: false,
        artifacts: [COMPLETE, ELIDED],
      })
    ).toBe(true);
  });
});

describe('elidedReplyWarning', () => {
  const ELIDED_MARKDOWN = `Here is the dashboard.

<artifact identifier="board" type="text/html" title="Board">
<html><body><script>
  function init() {
    // All the interactive JS from the previous complete artifact
  }
  init();
</script></body></html>
</artifact>`;

  const CLEAN_MARKDOWN = `Here is the dashboard.

<artifact identifier="board" type="text/html" title="Board">
<html><body><script>
  function init() { document.title = 'Board'; }
  init();
</script></body></html>
</artifact>`;

  it('trusts the server verdict when it survived the save', () => {
    expect(
      elidedReplyWarning({ suspectedElision: { confidence: 'low', signalCount: 2, details: [] } }, undefined)
    ).toBe(true);
  });

  it('falls back to scanning the markdown when there is no server verdict', () => {
    expect(elidedReplyWarning({}, ELIDED_MARKDOWN)).toBe(true);
    expect(elidedReplyWarning(undefined, ELIDED_MARKDOWN)).toBe(true);
    expect(elidedReplyWarning(null, ELIDED_MARKDOWN)).toBe(true);
  });

  it('does not warn on a reply whose artifact is complete', () => {
    expect(elidedReplyWarning({}, CLEAN_MARKDOWN)).toBe(false);
  });

  it('does not warn when there is nothing to share', () => {
    expect(elidedReplyWarning({}, undefined)).toBe(false);
    expect(elidedReplyWarning({}, '')).toBe(false);
  });

  it('does not warn on ordinary prose that merely discusses abbreviation', () => {
    // The reply body is prose, not code, so the comment-context anchoring is what has to hold here -
    // this surface scans raw markdown with no artifact type to gate on.
    const prose = 'The changelog below is abbreviated for brevity; the rest of the entries are omitted.';
    expect(elidedReplyWarning({}, prose)).toBe(false);
  });
});

describe('validateArtifactContent - HTML structure', () => {
  // The check used to be exact-case on '<!DOCTYPE', so a lowercase doctype - valid HTML, and
  // what several models emit - was reported as malformed and the viewer showed a warning
  // over a page that rendered perfectly well.
  it.each([
    '<!DOCTYPE html><html><body>hi</body></html>',
    '<!doctype html><body>hi</body>',
    '<HTML><body>hi</body></HTML>',
  ])('accepts %s', content => {
    expect(validateArtifactContent('html', content).errors).not.toContain(
      'HTML artifacts should include proper HTML structure'
    );
  });

  it('still flags content with no HTML structure at all', () => {
    expect(validateArtifactContent('html', 'just some text').errors).toContain(
      'HTML artifacts should include proper HTML structure'
    );
  });
});
/**
 * The fenced detectors match a fence on its own and check the promotion anchors in the
 * callback, so these cases pin the promotion decisions and the behaviour that changed
 * when the anchors moved out of the patterns. Mirrors the twin suite in b4m-core/utils/src/artifactParser.test.ts,
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
    for (const label of ['html', 'svg', 'tsx', 'python', 'json']) {
      // Sized so EVERY label fails on the 500ms ceiling pre-fix, not on the growth ratio:
      // the ratio's true quadratic value is 4.0 and the check is < 3, but a 30000-char run
      // costs the tsx/python/json labels far less than html or svg, and a MIN_BASELINE_MS
      // floor that low leaves a noisy baseline read enough room to pass against unfixed
      // code. Measured in-suite on a quiet host, pre-fix html breaches the 500ms ceiling
      // by about 148x at n=180000; the loop aborts on that first label, so the other
      // labels are not independently measured here - they are the same shape and the
      // same size, differing only in the fence label. The current parser needs well
      // under a millisecond either side, so the budget is really GC noise in the
      // measured window.
      // At this size the fixed parser's baseline is a fraction of a millisecond for most
      // labels, so the ratio collapses into an absolute budget that measures shared-runner
      // noise; the real guard here is the 500ms small-input ceiling above, which pre-fix
      // code breaches by several times over, so raise the floor for this call only.
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

  // The two cases below pin a deliberate deviation from the pre-change regexes, which built
  // their bodies from `.` and `\n` and so could never cross a CR, a U+2028 or a U+2029.
  // `[\s\S]*?` can, which is what the core parser already did.

  it('promotes an svg fence whose body carries a CR, which the pre-change pattern refused', () => {
    const out = convertCodeBlocksToArtifacts('```svg\n<svg>\r</svg>\n```');
    expect(out).toContain('type="image/svg+xml"');
    expect(out).not.toContain('```svg');
  });

  it('titles a CRLF doctype html fence as a document, where the pre-change pattern left it a snippet', () => {
    const out = convertCodeBlocksToArtifacts('```html\n<!DOCTYPE html>\r\n<html><body>hi</body></html>\n```');
    expect(out).toContain('title="HTML Page"');
    expect(out).toContain('identifier="html-page"');
    expect(out).not.toContain('HTML Snippet');
  });

  // Mirrors MAX_FENCE_SCAN_CHARS in the source file (not exported). The five React
  // indicator predicates are regex-based and read only the first 256000 chars of a
  // fence body, so indicators sitting past that window leave the fence a plain code
  // block - the deliberate DoS ceiling, not a correctness bug. The html and svg
  // detectors are indexOf scans and are deliberately not capped.
  const MAX_FENCE_SCAN_CHARS = 256000;

  it('leaves a react fence whose indicators sit past the scan window as a plain code block', () => {
    const indicators = "import React from 'react';\nconst x = useState(0);\nreturn (\n<Foo />";
    const input = '```javascript\n' + 'x'.repeat(MAX_FENCE_SCAN_CHARS + 50000) + '\n' + indicators + '\n```';
    const out = convertCodeBlocksToArtifacts(input);
    expect(out).toBe(input);
    expect(out).not.toContain('<artifact');
  });

  it('promotes the same react fence when its indicators sit inside the scan window', () => {
    const indicators = "import React from 'react';\nconst x = useState(0);\nreturn (\n<Foo />";
    const input = '```javascript\n' + indicators + '\n' + 'x'.repeat(MAX_FENCE_SCAN_CHARS + 50000) + '\n```';
    expect(convertCodeBlocksToArtifacts(input)).toContain('type="application/vnd.ant.react"');
  });

  it('promotes a react fence whose indicators sit just inside the scan window', () => {
    // Pins the window from below: without this, lowering MAX_FENCE_SCAN_CHARS would silently
    // de-promote real fences while both of the cases above still passed.
    const indicators = "import React from 'react';\nconst x = useState(0);\nreturn (\n<Foo />";
    const input = '```javascript\n' + 'x'.repeat(MAX_FENCE_SCAN_CHARS - 1000) + '\n' + indicators + '\n```';
    expect(convertCodeBlocksToArtifacts(input)).toContain('type="application/vnd.ant.react"');
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

  it('drops a double quote from a tool-output chart title', () => {
    // \u0022 survives the deep-unescape loop, so a quote reaches metadata.title intact.
    const payload =
      '{"type":"recharts","metadata":{"title":"a\\u0022 type=\\u0022text/plain"},' +
      '"content":{"chartType":"bar","data":[{"x":1}]}}';
    const out = convertCodeBlocksToArtifacts('{"result": "' + payload + '"}');
    expect(out).toContain('type="application/vnd.ant.recharts"');
    expect(out).toMatch(/title="a type=text\/plain"/);
  });

  it('drops a double quote from a tool-output mermaid title', () => {
    // Same shape as the recharts case above (a Unicode escape survives the deep-unescape
    // loop, reaching metadata.title intact), pinning the mermaid title call site.
    const payload = '{"type":"mermaid","metadata":{"title":"a\\u0022 title"},"content":"graph TD"}';
    const out = convertCodeBlocksToArtifacts('{"result": "' + payload + '"}');
    expect(out).toContain('type="application/vnd.ant.mermaid"');
    expect(out).toMatch(/title="a title"/);
  });

  it('promotes a non-string tool-output title instead of dropping the artifact', () => {
    // metadata.title is model-controlled and not type-guaranteed; a number used to
    // throw inside the title sanitizer and leave the tool output as raw JSON text.
    const recharts = '{"type":"recharts","metadata":{"title":7},"content":{"chartType":"bar","data":[{"x":1}]}}';
    const chart = convertCodeBlocksToArtifacts('{"result": "' + recharts + '"}');
    expect(chart).toContain('type="application/vnd.ant.recharts"');
    expect(chart).toContain('title="7"');

    const mermaid = '{"type":"mermaid","metadata":{"title":7},"content":"graph TD"}';
    const diagram = convertCodeBlocksToArtifacts('{"result": "' + mermaid + '"}');
    expect(diagram).toContain('type="application/vnd.ant.mermaid"');
    expect(diagram).toContain('title="7"');
  });

  it('drops tag brackets from a tool-output title', () => {
    // </> survive the deep-unescape loop, so a bracket reaches metadata.title
    // intact. This file's ARTIFACT_REGEX reads a quoted value as a unit, but the repo's
    // other artifact matchers read attributes as [^>], where a bare > closes the tag and
    // hands everything after it to a re-typed artifact.
    const recharts =
      '{"type":"recharts","metadata":{"title":"a\\u003Cb\\u003Ec"},"content":{"chartType":"bar","data":[{"x":1}]}}';
    const chart = convertCodeBlocksToArtifacts('{"result": "' + recharts + '"}');
    expect(chart).toContain('type="application/vnd.ant.recharts"');
    expect(chart).toContain('title="abc"');

    const mermaid = '{"type":"mermaid","metadata":{"title":"a\\u003Cb\\u003Ec"},"content":"graph TD"}';
    const diagram = convertCodeBlocksToArtifacts('{"result": "' + mermaid + '"}');
    expect(diagram).toContain('type="application/vnd.ant.mermaid"');
    expect(diagram).toContain('title="abc"');
  });

  it('does not let a tool-output mermaid body inject a second artifact', () => {
    // toolOutput.content is model-controlled and lands in the rebuilt tag's body, which
    // ARTIFACT_REGEX ends at the first </artifact>. Unescaped, the tail below parses as a
    // second artifact of the model's chosen type.
    const payload =
      '{"type":"mermaid","metadata":{"title":"Diagram"},"content":' +
      JSON.stringify(
        "graph TD</artifact><artifact identifier='pwn' type='application/vnd.ant.react' title='Pwn'>export default () => null;"
      ) +
      '}';
    const result = parseArtifactsWithFallback('{"result": "' + payload + '"}');

    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].type).toBe('mermaid');
    expect(result.artifacts[0].identifier).toMatch(/^mermaid-/);
    expect(result.artifacts[0].content).not.toContain('<artifact');
  });

  it('round-trips a benign tool-output mermaid body unchanged', () => {
    const payload = '{"type":"mermaid","metadata":{"title":"My Diagram"},"content":"graph TD; A-->B;"}';
    const result = parseArtifactsWithFallback('{"result": "' + payload + '"}');

    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].type).toBe('mermaid');
    expect(result.artifacts[0].title).toBe('My Diagram');
    expect(result.artifacts[0].content).toBe('graph TD; A-->B;');
  });

  it('does not let a tool-output recharts body inject a second artifact', () => {
    // Same hole on the chart branch. Asserted in artifact display mode because the inline
    // default rewrites the chart to a fence, which would hide the injected tag's fate.
    const payload =
      '{"type":"recharts","metadata":{"title":"Chart"},"content":{"chartType":"bar","data":[{"x":1}],"note":' +
      JSON.stringify("</artifact><artifact identifier='pwn' type='application/vnd.ant.react' title='Pwn'>evil") +
      '}}';
    const result = parseArtifactsWithFallback('{"result": "' + payload + '"}', {
      rechartsDisplayMode: 'artifact',
    });

    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].type).toBe('recharts');
    expect(result.artifacts[0].identifier).toMatch(/^recharts-/);
    // The escape is lossless: the body is JSON, so the consumer's parse restores it.
    expect(JSON.parse(result.artifacts[0].content).note).toBe(
      "</artifact><artifact identifier='pwn' type='application/vnd.ant.react' title='Pwn'>evil"
    );
  });

  it('round-trips a benign tool-output recharts body unchanged', () => {
    const payload =
      '{"type":"recharts","metadata":{"title":"My Chart"},"content":{"chartType":"bar","data":[{"x":1}]}}';
    const result = parseArtifactsWithFallback('{"result": "' + payload + '"}', {
      rechartsDisplayMode: 'artifact',
    });

    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].type).toBe('recharts');
    expect(result.artifacts[0].title).toBe('My Chart');
    expect(JSON.parse(result.artifacts[0].content)).toEqual({ chartType: 'bar', data: [{ x: 1 }] });
  });

  it('counts a self-closing tag with a long attribute span as JSX syntax', () => {
    // 605 attribute characters, an ordinary inline SVG path. A capped attribute scan
    // stopped matching it, which silently cost the fence its second React indicator.
    const path = '<path d="' + 'M0 0 L1 1 '.repeat(60) + '"/>';
    expect(path.length).toBe(612);
    const code = 'const [n, setN] = useState(0);\nconst icon = ' + path + ';';
    expect(convertCodeBlocksToArtifacts('```javascript\n' + code + '\n```')).toContain(
      'type="application/vnd.ant.react"'
    );
  });

  it('scales linearly on a fence body of unmatched openings ahead of a single closer', () => {
    // `<a` repeated then one `>`: every opening is a self-closing-tag candidate and the
    // only `>` is at the end, which made the uncached scan re-read to it from each opening
    // (~4x per doubling). Both sizes keep that `>` inside MAX_FENCE_SCAN_CHARS; past the
    // cap it is sliced off and the shape is fast either way, so the case would prove
    // nothing. Measured in-suite on a quiet host, pre-fix breaches the 500ms ceiling by
    // about 5.15x at n=60000 alone; current runs 0.8/1.7ms; the raised floor below is
    // belt and braces once the ceiling is the real guard.
    assertLinearGrowth(
      n => '```javascript\n' + '<a'.repeat(n) + '>\n```',
      60000,
      (out, input) => expect(out).toBe(input),
      convertCodeBlocksToArtifacts,
      150
    );
  });

  it('counts an import whose from clause sits on the next line as a react import', () => {
    const code = "import Thing\n  from 'react';\nconst [n, setN] = useState(0);";
    expect(convertCodeBlocksToArtifacts('```javascript\n' + code + '\n```')).toContain(
      'type="application/vnd.ant.react"'
    );
    // One indicator short without the import, so the case above really turns on it.
    expect(convertCodeBlocksToArtifacts('```javascript\nconst [n, setN] = useState(0);\n```')).not.toContain(
      'type="application/vnd.ant.react"'
    );
  });

  it('leaves an svg fence with no closing tag untouched, scaling linearly', () => {
    // Openings with no closer: the shape that made the old doubly-anchored
    // <svg>...</svg> pattern re-scan the body from each one. At small=700, measured
    // in-suite on a quiet host, pre-fix runs 2604/18463ms (well past the 500ms ceiling
    // on the small side alone), current runs 0.01/0.02ms; the raised floor below is
    // belt and braces once the ceiling is the real guard.
    assertLinearGrowth(
      n => '```svg\n' + '<svg '.repeat(n) + '\n```',
      700,
      (out, input) => expect(out).toBe(input),
      convertCodeBlocksToArtifacts,
      150
    );
  });

  it('leaves an unterminated html fence untouched, scaling linearly', () => {
    // Many <!DOCTYPE occurrences and no </html> anywhere: the shape that made the old
    // doubly-anchored html pattern retry its full inner scan from each occurrence.
    // Measured in-suite on a quiet host, pre-fix runs 2290/9191ms at n=2800/5600 (well
    // past the ceiling on the small side alone), current runs 0.05/0.10ms; the raised
    // floor below is belt and braces.
    assertLinearGrowth(
      n => '```html\n' + '<!DOCTYPE html>\n'.repeat(n),
      2800,
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

  it('leaves an unclosed tool-output result field untouched, scaling linearly', () => {
    // convertToolOutputsToArtifacts used to end with a tail fallback scanning
    // /"result":\s*"([^"]*(?:\\"[^"]*)*)"[^}]*\}/g. Its capture could not hold an escaped
    // quote (the greedy [^"]* swallows the backslash, so the alternation never engages),
    // which made the promotion below it unreachable. The scan still ran, and when no '}'
    // follows the result field the tail fails and the match walks the ambiguous
    // [^"]* / \\" alternation over the whole run: quadratic in its length. Sized so the
    // pre-fix baseline clears MIN_BASELINE_MS, leaving the growth ratio as the real
    // check: measured in-suite at 3.97 against the block, versus a 2ms total without
    // it. 'mermaid' is required to clear the hasTargetType gate on the whole function.
    assertLinearGrowth(n => '{"result":"mermaid ' + '\\"word\\" '.repeat(n), 4000);
  });
});

/**
 * promoteBareHtmlDocument is module-private and runs last inside
 * convertCodeBlocksToArtifacts, so these cases drive it through the public entry point.
 * MUST STAY IN SYNC with the twin suite in b4m-core/utils/src/artifactParser.test.ts.
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
    // Every size is set so pre-fix breaches the 500ms small-input ceiling outright
    // instead of a ratio a loaded runner's noise can flip: at a size where pre-fix is
    // merely slow, the current parser's own cost is a few milliseconds, so an unraised
    // floor turns the ratio into an absolute ~75ms budget on the doubled run that a
    // loaded shared runner can miss on noise alone. These run the client parser
    // (assertLinearGrowth's run param defaults to it, not the core parser exercised
    // below); measured in-suite on a quiet host, pre-fix breaches the ceiling by about
    // 2.21x at n=28000 alone on the first shape (the call aborts at the first shape, so
    // the other two sizes are not independently measured here), against 4.9/12.8ms,
    // 0.3/0.5ms and 0.05/0.10ms now. The raised floor is
    // belt and braces once the ceiling is the real guard - the first shape needs it
    // most, since it promotes every document and its output allocation is what costs.
    const noOutputCheck = () => {};
    assertLinearGrowth(n => '<html></html>\n'.repeat(n), 28000, noOutputCheck, convertCodeBlocksToArtifacts, 150);
    assertLinearGrowth(n => '<html>\n'.repeat(n), 32000, noOutputCheck, convertCodeBlocksToArtifacts, 150);
    assertLinearGrowth(
      n => '```html\n' + '<!DOCTYPE html>\n'.repeat(n),
      2000,
      noOutputCheck,
      convertCodeBlocksToArtifacts,
      150
    );
  });
});

/**
 * apps/client depends on @bike4mind/utils, so this is the one suite that can reach
 * both parser copies and catch silent drift between the two MUST-STAY-IN-SYNC files.
 * Only behaviors both parsers genuinely implement are covered here: core has no
 * python-artifact promotion at all (that predicate is a client-only surface, unlike
 * the react fences, which are also excluded - the per-language react predicates
 * differ from core's hasReactComponentLine by design), so the python case below
 * only pins the one shape both agree on (a small fence neither promotes).
 *
 * The core side of this comparison (coreConvertCodeBlocksToArtifacts / coreParseArtifacts)
 * resolves through @bike4mind/utils' package exports to b4m-core/utils/dist, not source.
 * `pnpm turbo:core:build` rebuilds that dist after any core change. CI does not run turbo
 * for tests at all: each client shard runs `pnpm --recursive --filter @bike4mind/client test
 * --shard=i/3`, which builds nothing. It is safe because the test job depends on a separate
 * core-build job and restores that job's dist artifact before the run, falling back to
 * `pnpm core:build` if the download fails. Staleness is therefore a local-run hazard, which
 * the export-surface check at the top of this file and the cases below exist to catch.
 */
describe('parity with the core parser', () => {
  const DOC = '<!DOCTYPE html>\n<html><head><title>Page</title></head><body><h1>Hi</h1></body></html>';

  // Content pins against a stale core dist; an mtime comparison cannot do this job, since
  // mtime moves on a branch switch while content does not, and turbo then skips the
  // rebuild its own message asks for. Only the title case catches a dist built from main,
  // because the title escaping is this branch's only behavior change in core. The four
  // after it pin the linearizations, which are behavior-preserving by design, so they catch
  // a dist whose rewrite is broken, not a dist built from main, and not a same-behavior
  // revert.
  const coreWrappers = (out: string) => (out.match(/<artifact /g) || []).length;

  it('core dist strips a double quote from a promoted document title', () => {
    const doc = '<!DOCTYPE html>\n<html><head><title>Say "Hi"</title></head><body>Hi</body></html>';
    expect(coreConvertCodeBlocksToArtifacts(doc), STALE).toContain('title="Say Hi"');
  });

  // Core already split adjacent fences before this branch (its document scan was a lazy
  // body plus hasFullHtmlDocument as of #2827), so this pins no change of ours. It stays
  // as a broken-rewrite guard: a greedy body in either scan merges the two into one
  // artifact and leaves a bare ```html inside it, which both assertions below catch.
  it('core dist keeps two adjacent html fences separate', () => {
    const out = coreConvertCodeBlocksToArtifacts('```html\n' + DOC + '\n```\n\n```html\n' + DOC + '\n```');
    expect(coreWrappers(out), STALE).toBe(2);
    expect(out, STALE).not.toContain('```html');
  });

  it('core dist keeps the mermaid fence body non-greedy', () => {
    const two = '```mermaid\ngraph TD\n  A-->B\n```\n\n```mermaid\ngraph TD\n  C-->D\n```';
    expect(coreWrappers(coreConvertCodeBlocksToArtifacts(two)), STALE).toBe(2);
    // A greedy body would also stop requiring the trailing newline it used to match on.
    const unterminated = '```mermaid\ngraph TD\n  A-->B```';
    expect(coreConvertCodeBlocksToArtifacts(unterminated), STALE).toBe(unterminated);
  });

  it('core dist splices two bare documents without dropping or repeating the gaps', () => {
    const wrap = '<artifact identifier="page" type="text/html" title="Page">\n' + DOC + '\n</artifact>';
    expect(coreConvertCodeBlocksToArtifacts('A\n\n' + DOC + '\n\nB\n\n' + DOC + '\n\nC'), STALE).toBe(
      'A\n\n' + wrap + '\n\nB\n\n' + wrap + '\n\nC'
    );
  });

  it('core dist drops a comment-only svg artifact as graphically empty', () => {
    const content = '<artifact identifier="s" type="image/svg+xml" title="S">\n<svg><!-- note --></svg>\n</artifact>';
    expect(coreParseArtifacts(content).artifacts, STALE).toHaveLength(0);
  });

  const buildHtmlCall = (html: string) => JSON.stringify({ name: 'build_html', arguments: { html } });

  const cases: Array<{ name: string; input: string; promoted: boolean; type?: string }> = [
    {
      name: 'a full html document fenced as ```html',
      input: '```html\n' + DOC + '\n```',
      promoted: true,
      type: 'html',
    },
    {
      name: 'an svg fence with matching open/close tags',
      input: '```svg\n<svg viewBox="0 0 2 2"><rect width="1" height="1"/></svg>\n```',
      promoted: true,
      type: 'svg',
    },
    {
      name: 'a bare html document sitting in prose (no fence)',
      input: 'Here you go:\n\n' + DOC + '\n\nEnjoy.',
      promoted: true,
      type: 'html',
    },
    {
      name: 'an html fragment fence with no full document',
      input: '```html\n<div class="card"><p>hello</p></div>\n```',
      promoted: true,
      type: 'html',
    },
    {
      name: 'a build_html tool-call JSON fence',
      input: '```json\n' + buildHtmlCall('<html><body><p>hi</p></body></html>') + '\n```',
      promoted: true,
      type: 'html',
    },
    // Only shape where core and client agree on python: core never promotes any
    // python fence, so this pins the negative case rather than the (client-only) positive one.
    { name: 'a trivial python fence', input: '```python\nprint("hi")\n```', promoted: false },
    {
      name: 'an html document sitting inside a generic (unlabeled) code fence',
      input: '```\n' + DOC + '\n```',
      promoted: false,
    },
  ];

  it.each(cases)('agrees with the core parser on $name', ({ input, promoted, type }) => {
    const clientResult = parseArtifactsWithFallback(input);
    const coreConverted = coreConvertCodeBlocksToArtifacts(input);
    const coreResult = coreParseArtifacts(coreConverted);

    expect(clientResult.artifacts.length > 0).toBe(promoted);
    expect(coreResult.artifacts.length > 0).toBe(promoted);
    if (promoted && type) {
      expect(clientResult.artifacts[0].type).toBe(type);
      expect(coreResult.artifacts[0].type).toBe(type);
    }

    // The checks above pin each side against a hardcoded expectation independently,
    // which would stay green even if the two parsers diverged on title, content, or
    // any artifact past the first. Compare them directly, over every artifact.
    const pick = (a: { type: string; title: string; content: string }) => ({
      type: a.type,
      title: a.title,
      content: a.content,
    });
    expect(clientResult.artifacts.map(pick)).toEqual(coreResult.artifacts.map(pick));
  });
});

describe('hasSelfClosingTag differential vs the original regex', () => {
  // Oracle: the regex `hasSelfClosingTag` replaced (origin/main, inlined in `hasJSXSyntax`).
  // Copied verbatim so a behavior change shows up as a diff against this line, not this test.
  const originalHasSelfClosingTag = (code: string): boolean => /<[a-z]+[^>]*\/>/.test(code);

  // Vacuity control: same cached-cursor scan, but `close` is only ever sought once (the
  // `at + 2` refresh check is replaced with `< 0`), so a later candidate reuses a stale
  // cursor. Must diverge from the real implementation, or the corpus below proves nothing.
  const controlHasSelfClosingTag = (code: string): boolean => {
    let close = -1;
    for (let at = code.indexOf('<'); at >= 0; at = code.indexOf('<', at + 1)) {
      const nameChar = code.charCodeAt(at + 1);
      if (nameChar < 97 || nameChar > 122) continue;
      if (close < 0) {
        close = code.indexOf('>', at + 2);
        if (close < 0) return false;
      }
      if (close >= at + 3 && code[close - 1] === '/') return true;
    }
    return false;
  };

  // Deterministic PRNG (mulberry32, fixed seed) so the corpus is identical on every run.
  function mulberry32(seed: number): () => number {
    let s = seed;
    return () => {
      s |= 0;
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rand = mulberry32(0xc0ffee);
  const pickOne = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)];
  const randInt = (min: number, max: number): number => min + Math.floor(rand() * (max - min + 1));

  const tagOpeners = ['<a', '<div', '<path', '<A', '<h1', '<1a'] as const;
  const closers = ['/>', '>', ' />', '/ >'] as const;
  const junkChars = ['x', 'y', ' ', '-', '_', '.', ',', ':', ';', '(', ')', '{', '}', '\n', '\t'] as const;

  function randomAttrRun(withEmbeddedGt: boolean): string {
    let s = '';
    const n = randInt(0, 3);
    for (let i = 0; i < n; i++) {
      const quote = pickOne(['"', "'"] as const);
      let val = '';
      const vlen = randInt(0, 6);
      for (let j = 0; j < vlen; j++) val += pickOne(junkChars);
      if (withEmbeddedGt && rand() < 0.5) val += '>';
      s += ` attr${randInt(0, 9)}=${quote}${val}${quote}`;
    }
    return s;
  }

  function longAttrSpan(len: number): string {
    const unit = 'M0 0 L1 1 ';
    let s = '';
    while (s.length < len) s += unit;
    return s.slice(0, len);
  }

  function randomUnmatchedLtRun(): string {
    let s = '';
    const n = randInt(1, 8);
    for (let i = 0; i < n; i++) s += '<' + pickOne(['a', 'b', 'z', '1', ' '] as const);
    return s + '>';
  }

  function buildCase(): string {
    const kind = randInt(0, 12);
    switch (kind) {
      case 0:
        return '';
      case 1: {
        let s = '';
        const n = randInt(0, 40);
        for (let j = 0; j < n; j++) s += pickOne([...junkChars, 'a', 'b', 'c', '>', '/'] as const);
        return s;
      }
      case 2:
        return randomUnmatchedLtRun();
      case 3:
        return pickOne(tagOpeners) + randomAttrRun(rand() < 0.4) + pickOne(closers);
      case 4: {
        let s = '';
        const n = randInt(1, 5);
        for (let j = 0; j < n; j++) {
          s += pickOne(junkChars);
          s += pickOne(tagOpeners) + randomAttrRun(rand() < 0.3) + pickOne(closers);
        }
        return s;
      }
      case 5:
        return `${pickOne(['<path', '<a', '<div'] as const)} d="${longAttrSpan(600)}"/>`;
      case 6:
        return `${pickOne(['<path', '<a', '<div'] as const)} d="${longAttrSpan(5000)}"/>`;
      case 7:
        return `${pickOne(tagOpeners)} d="${longAttrSpan(randInt(400, 700))}">`;
      case 8:
        return pickOne(tagOpeners) + randomAttrRun(true) + '>';
      case 9: {
        let s = '';
        const n = randInt(5, 60);
        for (let j = 0; j < n; j++) s += pickOne(['<', '>', '/', 'a', ' ', 'Z', '9'] as const);
        return s;
      }
      case 10:
        return (
          pickOne(junkChars) +
          '<9bad>' +
          pickOne(junkChars) +
          pickOne(tagOpeners) +
          randomAttrRun(false) +
          pickOne(closers)
        );
      case 11:
        return '<1a>' + '<A>' + pickOne(tagOpeners) + randomAttrRun(rand() < 0.3) + pickOne(closers);
      default: {
        let s = '';
        const n = randInt(0, 80);
        for (let j = 0; j < n; j++)
          s += pickOne(['<', '>', '/', ' ', 'a', 'b', 'c', 'A', '1', '"', "'", '\n'] as const);
        return s;
      }
    }
  }

  const CORPUS_SIZE = 20000;
  const case600 = `<path d="${longAttrSpan(600)}"/>`;
  const case5000 = `<path d="${longAttrSpan(5000)}"/>`;
  const CORPUS: string[] = Array.from({ length: CORPUS_SIZE }, () => buildCase());
  CORPUS.push(case600, case5000);

  interface Directions {
    missing: number; // oracle-true cases the implementation did not catch
    extra: number; // implementation-true cases the oracle did not have
    examples: string[];
  }

  it('reproduces the original regex verdict on every corpus case, in both directions', () => {
    const directions: Directions = { missing: 0, extra: 0, examples: [] };
    for (const source of CORPUS) {
      const actual = hasSelfClosingTag(source);
      const expected = originalHasSelfClosingTag(source);
      if (actual !== expected) {
        if (expected && !actual) directions.missing++;
        else directions.extra++;
        if (directions.examples.length < 5) directions.examples.push(JSON.stringify(source));
      }
    }
    expect(directions).toEqual({ missing: 0, extra: 0, examples: [] });
  });

  it('diverges from the no-refresh control, so the corpus above is not vacuous', () => {
    let divergences = 0;
    for (const source of CORPUS) {
      if (hasSelfClosingTag(source) !== controlHasSelfClosingTag(source)) divergences++;
    }
    expect(divergences).toBeGreaterThan(0);
  });

  it('matches a self-closing tag with a 600-char and a ~5000-char attribute span', () => {
    expect(hasSelfClosingTag(case600)).toBe(true);
    expect(hasSelfClosingTag(case5000)).toBe(true);
  });
});
