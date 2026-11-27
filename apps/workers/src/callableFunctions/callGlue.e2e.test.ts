import { describe, it, expect, beforeAll } from 'vitest';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { PyodideInterface } from 'pyodide';
import { FUNCTION_CALL_GLUE_PY } from '@bike4mind/common';

// The glue the browser sandbox also runs (sandboxWorkerBody.test.ts checks its copy is this text), here under
// real Pyodide so its output type check is run rather than read.
const PYODIDE_DIR = realpathSync(path.dirname(createRequire(import.meta.url).resolve('pyodide')));

let pyodide: PyodideInterface;

beforeAll(async () => {
  const { loadPyodide } = await import('pyodide');
  pyodide = await loadPyodide({ indexURL: `${PYODIDE_DIR}/`, stdout: () => {}, stderr: () => {} });
}, 120_000);

const OUTPUTS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    count: { type: 'integer', unit: '1' },
    counts: { type: 'array', items: { type: 'integer', unit: '1' } },
    grid: { type: 'array', items: { type: 'array', items: { type: 'number', unit: 'm' } } },
    points: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { x: { type: 'number', unit: 'm' }, n: { type: 'integer', unit: '1' } },
      },
    },
    group: {
      type: 'object',
      additionalProperties: false,
      properties: { n: { type: 'integer', unit: '1' } },
    },
  },
};

async function call(returned: string): Promise<{ problems: unknown; error: unknown }> {
  const code = `FUNCTION = {"outputs": ${JSON.stringify(OUTPUTS).replace(/\bfalse\b/g, 'False')}}\n\ndef run():\n    return ${returned}\n`;
  pyodide.globals.set('_fn_code', code);
  pyodide.globals.set('_fn_params_json', '{}');
  const result = await pyodide.runPythonAsync(FUNCTION_CALL_GLUE_PY);
  const fields = result.toJs({ dict_converter: Object.fromEntries }) as Record<string, unknown>;
  result.destroy();
  const text = fields.output_problems_json;
  return { problems: typeof text === 'string' ? JSON.parse(text) : [], error: fields.error ?? null };
}

describe('the call glue output type check, run under Pyodide', () => {
  it('refuses 3.0 for an integer and True for a number at the top level', async () => {
    expect(await call('{"count": 3.0}')).toEqual({
      problems: [{ path: 'count', message: 'must be a whole number' }],
      error: null,
    });
    expect(await call('{"points": [{"x": True}]}')).toMatchObject({
      problems: [{ path: 'points.0.x', message: 'must be a number' }],
    });
  });

  it('walks a tuple as a list, which JSON writes the same way', async () => {
    expect(await call('{"counts": (1, 2.0, 3)}')).toEqual({
      problems: [{ path: 'counts.1', message: 'must be a whole number' }],
      error: null,
    });
    expect(await call('{"grid": ((1.0, 2.0), [3.0, False])}')).toMatchObject({
      problems: [{ path: 'grid.1.1', message: 'must be a number' }],
    });
  });

  it('walks objects inside lists and lists inside objects', async () => {
    expect(await call('{"points": ({"x": 1.5, "n": 2.0},), "group": {"n": 4.0}}')).toMatchObject({
      problems: [
        { path: 'points.0.n', message: 'must be a whole number' },
        { path: 'group.n', message: 'must be a whole number' },
      ],
    });
  });

  it('passes whole numbers and floats that match their fields', async () => {
    expect(await call('{"count": 3, "counts": (1, 2), "grid": [(1, 2.5)], "group": {"n": 4}}')).toEqual({
      problems: [],
      error: null,
    });
  });
});
