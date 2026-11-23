import { describe, it, expect, afterAll } from 'vitest';
import path from 'node:path';
import type { FunctionContract } from '@bike4mind/common';
import { createInProcessCallableFunctionRunner } from '@bike4mind/server-utils/callableFunctions/runtimeRunner';
import { liveCallableFunctionChildren } from '@bike4mind/server-utils/callableFunctions/runtimeParent';

// The image's Pyodide layout: the core files, pyodide-lock.json, and the package wheels in one directory.
const PYODIDE_DIR_ENV = 'CALLABLE_FUNCTION_TEST_PYODIDE_DIR';
const PYODIDE_DIR = process.env[PYODIDE_DIR_ENV];
const CHILD = path.resolve(import.meta.dirname, 'child.ts');

const CONTRACT: FunctionContract = {
  name: 'package_check',
  description: 'Imports a package under the lockdown, uses it, and lists the ctypes names it touched.',
  inputs: { type: 'object', additionalProperties: false, properties: {} },
  outputs: {
    type: 'object',
    additionalProperties: false,
    required: ['detail', 'touched_import', 'touched_use'],
    properties: {
      detail: { type: 'string' },
      touched_import: { type: 'string' },
      touched_use: { type: 'string' },
    },
  },
};

const pythonLiteral = (contract: object): string => JSON.stringify(contract).replace(/\bfalse\b/g, 'False');

/** Records every name read from the ctypes module while the package imports, then while it is used. */
const packageCheck = (imports: string, use: string) => `
FUNCTION = ${pythonLiteral(CONTRACT)}

import types
import ctypes

_touched = []


class _Recording(types.ModuleType):
    def __getattribute__(self, name):
        if not name.startswith("__"):
            _touched.append(name)
        return types.ModuleType.__getattribute__(self, name)


ctypes.__class__ = _Recording
try:
${imports.trim().replace(/^/gm, '    ')}
except BaseException:
    import traceback
    traceback.print_exc()
    raise
_at_import = sorted(set(_touched))
del _touched[:]


def use():
${use.trim().replace(/^/gm, '    ')}


def run():
    try:
        detail = use()
    except BaseException:
        import traceback
        traceback.print_exc()
        raise
    return {"detail": detail, "touched_import": ",".join(_at_import), "touched_use": ",".join(sorted(set(_touched)))}
`;

interface PackageCase {
  name: string;
  imports: string;
  use: string;
  detail: RegExp;
}

const CASES: PackageCase[] = [
  {
    name: 'numpy',
    imports: 'import numpy as np',
    use: 'return "solve %s" % np.linalg.solve(np.array([[3.0, 1.0], [1.0, 2.0]]), np.array([9.0, 8.0])).tolist()',
    detail: /^solve \[2\.0, 3\.0\]$/,
  },
  {
    name: 'pandas',
    imports: 'import pandas as pd',
    use: `
frame = pd.DataFrame({"key": ["a", "b", "a"], "value": [1, 2, 3]})
return "group-by %s" % frame.groupby("key")["value"].sum().to_dict()`,
    detail: /^group-by \{'a': 4, 'b': 2\}$/,
  },
  {
    name: 'matplotlib',
    imports: `
import io
import matplotlib
import matplotlib.pyplot as plt`,
    use: `
figure, axes = plt.subplots()
axes.plot([1, 2, 3], [1, 4, 9])
buffer = io.BytesIO()
figure.savefig(buffer, format="png")
data = buffer.getvalue()
return "png %s, %d bytes, backend %s" % (data[:4] == b"\\x89PNG", len(data), matplotlib.get_backend())`,
    detail: /^png True, \d+ bytes, backend agg$/i,
  },
  {
    name: 'scipy',
    imports: `
import numpy as np
from scipy import linalg, optimize`,
    use: `
found = optimize.minimize(lambda v: (v[0] - 3.0) ** 2 + 1.0, [0.0]).x[0]
return "minimize %.4f, det %.4f" % (found, linalg.det(np.array([[1.0, 2.0], [3.0, 4.0]])))`,
    detail: /^minimize 3\.0000, det -2\.0000$/,
  },
  {
    name: 'scikit-learn',
    imports: `
import numpy as np
from sklearn.cluster import KMeans
from sklearn.linear_model import LinearRegression`,
    use: `
x = np.array([[0.0], [1.0], [2.0], [3.0]])
slope = LinearRegression().fit(x, 2 * x[:, 0] + 1).coef_[0]
labels = KMeans(n_clusters=2, n_init=1, random_state=0).fit(np.array([[0.0], [0.1], [5.0], [5.1]])).labels_
return "slope %.3f, %d clusters" % (slope, len(set(labels.tolist())))`,
    detail: /^slope 2\.000, 2 clusters$/,
  },
];

describe.skipIf(!PYODIDE_DIR)(
  `the five baked packages under the lockdown (set ${PYODIDE_DIR_ENV} to a Pyodide directory holding their wheels)`,
  () => {
    const runner = createInProcessCallableFunctionRunner({ childPath: CHILD, pyodideDir: PYODIDE_DIR ?? '' });
    const check = (imports: string, use: string) =>
      runner({ op: 'call', code: packageCheck(imports, use), contract: CONTRACT, params: {} });
    const table = ['| Package | Start (ms) | ctypes names at import | ctypes names in use |', '|---|---|---|---|'];

    afterAll(() => {
      console.log(table.join('\n'));
    });

    for (const pkg of CASES) {
      it(`imports and uses ${pkg.name}`, async () => {
        const result = await check(pkg.imports, pkg.use);
        const outputs = result.outputs ?? {};
        const [atImport, inUse] = [outputs.touched_import || '(none)', outputs.touched_use || '(none)'];
        table.push(`| ${pkg.name} | ${result.startMs} | ${atImport} | ${inUse} |`);
        expect(result, result.printed).toMatchObject({ outcome: 'ok' });
        expect(outputs.detail).toMatch(pkg.detail);
        expect(liveCallableFunctionChildren()).toEqual([]);
      }, 120_000);
    }

    it('starts with all five loaded inside the start budget', async () => {
      const imports = CASES.map(pkg => pkg.imports).join('\n');
      const result = await check(imports, 'return "loaded"');
      table.push(`| all five | ${result.startMs} | ${result.outputs?.touched_import ?? ''} | |`);
      expect(result, result.printed).toMatchObject({ outcome: 'ok', outputs: { detail: 'loaded' } });
    }, 120_000);
  }
);
