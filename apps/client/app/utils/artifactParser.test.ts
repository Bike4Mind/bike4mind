import { describe, it, expect } from 'vitest';
import { extractReactDependencies, parseArtifactsWithFallback, isSvgGraphicallyEmpty } from './artifactParser';

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
});
