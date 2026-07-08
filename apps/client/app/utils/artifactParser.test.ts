import { describe, it, expect } from 'vitest';
import { extractReactDependencies, parseArtifactsWithFallback } from './artifactParser';

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
