import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildReactArtifactBundle } from './transpileReactArtifact';

// Single-file publish output pinned byte for byte, so multi-file support cannot drift it. The
// fixtures were captured before multi-file publish existed; regenerate only for an intended change.
const PINNED_SINGLE_FILE_CASES: Record<string, string> = {
  counter: `import { useState } from 'react';
function Counter() {
  const [count, setCount] = useState(0);
  return (
    <div className="p-4">
      <span>{count}</span>
      <button onClick={() => setCount(c => c + 1)}>+</button>
    </div>
  );
}
export default Counter;`,
  deps: `import React, { forwardRef, useId as makeId } from 'react';
import { capitalize } from 'lodash';
import { Home, Settings } from 'lucide-react';
import * as d3 from 'd3';
import { LineChart, Line } from 'recharts';
const Label = forwardRef((props, ref) => <span ref={ref}>{capitalize(props.text)}</span>);
export default function App() {
  const id = makeId();
  const scale = d3.scaleLinear().domain([0, 1]).range([0, 100]);
  return (
    <div id={id}>
      <Home size={16} /><Settings />
      <Label text="hello" />
      <LineChart width={200} height={100} data={[{ v: scale(0.5) }]}><Line dataKey="v" /></LineChart>
      <p>{"</script> stays escaped"}</p>
    </div>
  );
}`,
  typescript: `import type Foo from './types';
import { type Dispatch, useReducer } from 'react';
interface Props { start?: number }
type Action = { kind: 'inc' } | { kind: 'dec' };
function reducer(n: number, a: Action): number { return a.kind === 'inc' ? n + 1 : n - 1; }
const Stepper = ({ start = 0 }: Props) => {
  const [n, dispatch]: [number, Dispatch<Action>] = useReducer(reducer, start);
  return <button onClick={() => dispatch({ kind: 'inc' })}>{n}</button>;
};
export { Stepper as default };`,
};

describe('single-file react bundle output', () => {
  it.each(Object.keys(PINNED_SINGLE_FILE_CASES))('%s matches its pinned bundle', async name => {
    const { indexHtml } = await buildReactArtifactBundle({
      source: PINNED_SINGLE_FILE_CASES[name],
      title: `Pinned ${name}`,
    });
    expect(indexHtml).toBe(readFileSync(resolve(__dirname, '__fixtures__/reactBundle', `${name}.html`), 'utf8'));
  });
});
