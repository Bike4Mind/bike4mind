import { describe, it, expect } from 'vitest';
import { extractReactDependencies } from './artifactParser';

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
