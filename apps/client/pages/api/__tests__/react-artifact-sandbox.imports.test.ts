import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { describe, it, expect } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import handler from '../react-artifact-sandbox';
import { IMPORT_SCANNER_FACTORY_SRC, type ImportScanner } from '@client/app/utils/importStatements';

/**
 * Everything under test here is pulled out of the real GET response and run in a vm, so what is
 * checked is the script the iframe receives, not the module the route interpolates from.
 */
function sandboxHtml(): string {
  let body = '';
  const res = {
    setHeader: () => undefined,
    status: () => res,
    send: (payload: string) => {
      body = payload;
      return res;
    },
  } as unknown as NextApiResponse;
  handler({ method: 'GET' } as NextApiRequest, res);
  return body;
}

/** The one inline (non-src) script block containing `marker`. */
function inlineScript(html: string, marker: string): string {
  const blocks = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g), m => m[1]).filter(b => b.includes(marker));
  expect(blocks).toHaveLength(1);
  return blocks[0];
}

const HTML = sandboxHtml();
const FACTORY_BLOCK = inlineScript(HTML, 'var importScanner = null;');
const MAIN_BLOCK = inlineScript(HTML, 'function renderArtifact(');

// Counts characters the scanner inspects through String/RegExp built-ins. Plain `source[i]`
// reads cannot be intercepted, which is what the wall-clock ceiling below backstops.
const OP_COUNTER = `
var __ops = 0;
(function () {
  var SP = String.prototype, RP = RegExp.prototype;
  var indexOf = SP.indexOf, lastIndexOf = SP.lastIndexOf, startsWith = SP.startsWith, slice = SP.slice, exec = RP.exec;
  SP.indexOf = function (needle, from) {
    var start = Math.max(0, from | 0), r = indexOf.call(this, needle, from);
    __ops += (r < 0 ? this.length : r + String(needle).length) - start + 1;
    return r;
  };
  SP.lastIndexOf = function (needle, from) {
    var start = from === undefined ? this.length : from, r = lastIndexOf.call(this, needle, from);
    __ops += start - (r < 0 ? 0 : r) + 1;
    return r;
  };
  SP.startsWith = function (needle, at) { __ops += String(needle).length + 1; return startsWith.call(this, needle, at); };
  SP.slice = function (a, b) { var r = slice.call(this, a, b); __ops += r.length + 1; return r; };
  RP.exec = function (s) {
    var start = this.global || this.sticky ? this.lastIndex : 0, m = exec.call(this, s);
    __ops += (m ? m.index + m[0].length : String(s).length) - start + 1;
    return m;
  };
})();
`;

interface SandboxGlobals {
  importScanner: ImportScanner | null;
  rewriteImportsForSandbox(code: string): string;
  __ops: number;
}

interface Sandbox {
  globals: SandboxGlobals;
  /** Drives renderArtifact through the real message handler; resolves once the render settles. */
  render(code: string): Promise<{ transformed: string | undefined; errors: string[] }>;
}

function bootSandbox(opts: { factoryBlock?: string; mainBlock?: string; countOps?: boolean } = {}): Sandbox {
  const posted: { type: string; message?: string }[] = [];
  const babelInputs: string[] = [];
  const listeners: Record<string, ((event: unknown) => void)[]> = {};
  const el = () => ({ innerHTML: '', textContent: '', className: '', appendChild: () => undefined });
  const parent = { postMessage: (msg: { type: string; message?: string }) => posted.push(msg) };
  const window = {
    parent,
    addEventListener: (type: string, fn: (event: unknown) => void) => (listeners[type] ||= []).push(fn),
  };
  const context = vm.createContext({
    window,
    document: {
      getElementById: el,
      createElement: el,
      createTextNode: (text: string) => ({ text }),
      head: el(),
      body: el(),
    },
    React: { createElement: () => null },
    ReactDOM: { createRoot: () => ({ render: () => undefined }) },
    // Babel's input is the rewritten artifact, so recording it captures transformedCode.
    Babel: {
      transform: (code: string) => {
        babelInputs.push(code);
        return { code: 'export default function C() { return null; }' };
      },
    },
  });
  if (opts.countOps) vm.runInContext(OP_COUNTER, context);
  vm.runInContext(opts.factoryBlock ?? FACTORY_BLOCK, context);
  vm.runInContext(opts.mainBlock ?? MAIN_BLOCK, context);
  const globals = context as unknown as SandboxGlobals;
  return {
    globals,
    async render(code) {
      babelInputs.length = 0;
      posted.length = 0;
      for (const fn of listeners.message ?? []) fn({ source: parent, data: { type: 'react-artifact-render', code } });
      await new Promise(resolve => setImmediate(resolve));
      return {
        transformed: babelInputs[0],
        errors: posted.filter(m => m.type === 'react-sandbox-error').map(m => String(m.message)),
      };
    },
  };
}

// ---- Oracles: the pre-change sandbox code, verbatim apart from TS types and un-doubled escapes ----

function legacyStrip(code: string): string {
  return code
    .replace(/import\s+type\s+[\s\S]*?\s+from\s+['"][^'"]+['"]\s*;?/g, '')
    .replace(/import\s+([\s\S]*?)\s+from\s+['"][^'"]+['"]\s*;?/g, function (stmt: string, clause: string) {
      const brace = clause.match(/\{([\s\S]*?)\}/);
      if (!brace) return stmt;
      const kept = brace[1]
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .filter(s => !/^type\s+(?!as\b)\w/.test(s));
      const beforeBrace = clause.slice(0, clause.indexOf('{')).replace(/,\s*$/, '').trim();
      if (!kept.length && !beforeBrace) return '';
      return stmt.replace(/\{[\s\S]*?\}/, '{ ' + kept.join(', ') + ' }');
    });
}

function legacyRelative(code: string): string | null {
  const m =
    code.match(/(?:import|export)\b[^;'"]*\bfrom\s*['"](\.\.?\/[^'"]+)['"]/) ||
    code.match(/\bimport\s*['"](\.\.?\/[^'"]+)['"]/) ||
    code.match(/\brequire\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/);
  return m ? m[1] : null;
}

function legacyRewrite(code: string): string {
  const renameNamed = (clause: string) => clause.replace(/(\w+)\s+as\s+(\w+)/g, '$1: $2');
  return code.replace(
    /import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g,
    function (_m: string, imports: string, module: string) {
      if (module === 'react') return '// React is global';
      if (imports.trim().match(/^\w+$/)) return 'const ' + imports.trim() + " = require('" + module + "');";
      const ns = imports.trim().match(/^\*\s+as\s+(\w+)$/);
      if (ns) return 'const ' + ns[1] + " = require('" + module + "');";
      const mixed = imports.trim().match(/^(\w+)\s*,\s*(\{[\s\S]*\})$/);
      if (mixed)
        return (
          'const ' + mixed[1] + " = require('" + module + "'); const " + renameNamed(mixed[2]) + ' = ' + mixed[1] + ';'
        );
      return 'const ' + renameNamed(imports) + " = require('" + module + "');";
    }
  );
}

// ---- Corpus ----

const REQUIRED_CASES: readonly string[] = [
  '',
  'const x = 1;\nexport default x;',
  "import a from 'x' import { b as c } from 'y'",
  "import a from 'x'\nimport * as d3 from 'd3'\nimport Foo, { bar } from 'mod'\n",
  "import * as d3 from 'd3';",
  "import Foo, { bar, baz as qux } from 'mod';",
  "import { a as b, c as d } from 'm';",
  "import {} from 'm';",
  "import { a from 'm",
  "import a from 'x",
  "import a from 'x'\r\nimport { b } from 'y'\r\n",
  "import a\u2028from 'x'\u2028import { b }\u2029from 'y'",
  "import type { T } from './types';\nimport { type U, v } from 'm';",
  "import { type T } from 'm'; import React, { type FC, useState } from 'react';",
  "import x from './a';",
  "export { y } from '../b';",
  "import './side';",
  "const c = require('./c');",
];

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const WS = [' ', '  ', '\n', '\r\n', '\t', '\u2028', '\u00a0', ''];
// No `$` anywhere: the old strip passed kept names through a replace() pattern, turning `$$a`
// into `$a`. That fix is intentional and pinned on its own below.
const CLAUSES = [
  'React',
  'x',
  '{ a }',
  '{ a, b as c }',
  '* as ns',
  'A, { b as c }',
  '{\n  A,\n  B,\n}',
  'type X',
  '{ type X, y }',
  '{ type X }',
  'type',
  'a from',
  '',
];
const SPECS = ['react', 'lodash', './rel', '../up', 'd3', 'lucide-react'];
const TAILS = ['', ';', ' ;', '\n', ';\n'];
const KEYWORDS = ['import', 'import', 'import', 'import type', 'export', 'reimport', 'import('];
const NOISE = [
  '\n',
  '',
  '\nconst x = 1;\n',
  '// note\n',
  "require('./r')\n",
  "import './s'\n",
  ' from ',
  "'",
  '}',
  '{',
];

const CORPUS: readonly string[] = (() => {
  const rand = lcg(0x0decade5);
  const pick = (arr: readonly string[]) => arr[Math.floor(rand() * arr.length)];
  const cases = [...REQUIRED_CASES];
  for (let i = 0; i < 2500; i++) {
    let text = pick(NOISE);
    for (let j = 1 + Math.floor(rand() * 3); j > 0; j--) {
      const q = rand() < 0.5 ? "'" : '"';
      text += `${pick(KEYWORDS)}${pick(WS)}${pick(CLAUSES)}${pick(WS)}from${pick(WS)}${q}${pick(SPECS)}${q}${pick(TAILS)}${pick(NOISE)}`;
    }
    cases.push(text);
  }
  return cases;
})();

/** Corpus cases where the emitted script and the legacy code disagree, per stage. */
function divergences(sandbox: Sandbox): { strip: string[]; relative: string[]; rewrite: string[] } {
  const scanner = sandbox.globals.importScanner as ImportScanner;
  const out = { strip: [] as string[], relative: [] as string[], rewrite: [] as string[] };
  for (const code of CORPUS) {
    const stripped = legacyStrip(code);
    if (scanner.stripTypeOnlyImports(code) !== stripped) out.strip.push(code);
    if (scanner.findRelativeImport(stripped) !== legacyRelative(stripped)) out.relative.push(code);
    if (sandbox.globals.rewriteImportsForSandbox(stripped) !== legacyRewrite(stripped)) out.rewrite.push(code);
  }
  return out;
}

describe('emitted sandbox script: import scanner', () => {
  it('carries the scanner factory byte-for-byte in its own script block', () => {
    expect(FACTORY_BLOCK).toContain(`(${IMPORT_SCANNER_FACTORY_SRC})()`);
    expect(MAIN_BLOCK).not.toContain(IMPORT_SCANNER_FACTORY_SRC);
    expect(bootSandbox().globals.importScanner).not.toBeNull();
  });

  it('matches the legacy strip, relative guard and rewrite on every corpus case', () => {
    expect(CORPUS.length).toBeGreaterThan(2500);
    expect(divergences(bootSandbox())).toEqual({ strip: [], relative: [], rewrite: [] });
  });

  it('exercises the corpus: statements get rewritten, types stripped and relatives caught', () => {
    const sandbox = bootSandbox();
    const scanner = sandbox.globals.importScanner as ImportScanner;
    const rewritten = CORPUS.filter(c => sandbox.globals.rewriteImportsForSandbox(c) !== c).length;
    const stripped = CORPUS.filter(c => scanner.stripTypeOnlyImports(c) !== c).length;
    const relative = CORPUS.filter(c => scanner.findRelativeImport(c) !== null).length;
    for (const count of [rewritten, stripped, relative]) expect(count).toBeGreaterThan(CORPUS.length / 10);
  });

  it('keeps a `$$` binding intact where the legacy strip collapsed it to `$` (intentional fix)', () => {
    const code = "import { $$a, type T } from 'm';";
    expect(bootSandbox().globals.importScanner?.stripTypeOnlyImports(code)).toBe("import { $$a } from 'm';");
    expect(legacyStrip(code)).toBe("import { $a } from 'm';");
  });

  it('renders a multi-import dashboard with byte-identical transformed code to the legacy path', async () => {
    const dashboard = [
      "import React, { useState, useEffect } from 'react';",
      "import { LineChart, Line, XAxis, YAxis, Tooltip as Tip } from 'recharts';",
      "import * as d3 from 'd3';",
      "import _ from 'lodash'",
      "import { Camera as CameraIcon, Home } from 'lucide-react'",
      "import type { FC } from 'react';",
      '',
      'const Dashboard: FC = () => {',
      '  const [rows, setRows] = useState<number[]>([]);',
      '  useEffect(() => setRows(_.range(5)), []);',
      '  return <LineChart data={rows}><Line dataKey="v" /></LineChart>;',
      '};',
      'export default Dashboard;',
    ].join('\n');
    const { transformed, errors } = await bootSandbox().render(dashboard);
    expect(errors).toEqual([]);
    expect(transformed).toBe(legacyRewrite(legacyStrip(dashboard)));
    expect(transformed).toContain('// React is global');
    expect(transformed).toContain('{ Camera: CameraIcon, Home }');
  });

  it('reports a relative import through the real render path, as before', async () => {
    const { transformed, errors } = await bootSandbox().render("import x from './a';\nexport default x;");
    expect(transformed).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"./a"');
  });
});

describe('vacuity: the checks above fail when the emitted script is wrong', () => {
  const swapFactory = (mutate: (src: string) => string) => {
    const mutated = mutate(IMPORT_SCANNER_FACTORY_SRC);
    expect(mutated).not.toBe(IMPORT_SCANNER_FACTORY_SRC);
    return FACTORY_BLOCK.split(IMPORT_SCANNER_FACTORY_SRC).join(mutated);
  };

  it('a strip that no longer consumes the trailing `\\s*;?` diverges', () => {
    const factoryBlock = swapFactory(src => src.replace(/consumeTrailing: true/g, 'consumeTrailing: false'));
    expect(divergences(bootSandbox({ factoryBlock })).strip.length).toBeGreaterThan(0);
  });

  it("the publish transpiler's react handling (react imports kept) diverges", () => {
    const reactLine = "if (module === 'react') return '// React is global';";
    expect(MAIN_BLOCK).toContain(reactLine);
    const mainBlock = MAIN_BLOCK.replace(reactLine, () => '');
    expect(divergences(bootSandbox({ mainBlock })).rewrite.length).toBeGreaterThan(0);
  });

  it('a factory with a free reference fails to load and the in-iframe self-check reports it', async () => {
    const factoryBlock = swapFactory(src =>
      src.replace(/(['"])use strict\1;?/, m => `${m} var leaked = hostOnlyHelper;`)
    );
    const sandbox = bootSandbox({ factoryBlock });
    expect(sandbox.globals.importScanner).toBeNull();
    const { transformed, errors } = await sandbox.render("import a from 'x';\nexport default a;");
    expect(transformed).toBeUndefined();
    expect(errors).toEqual([expect.stringContaining('Import scanner failed to load')]);
    expect(errors[0]).toContain('hostOnlyHelper');
  });

  it('the op counter sees a quadratic scan', () => {
    const context = vm.createContext({});
    vm.runInContext(OP_COUNTER, context);
    const len = 16000;
    vm.runInContext(
      `var s = new Array(${len + 1}).join('a'); for (var i = 0; i < s.length; i++) s.indexOf('b', i);`,
      context
    );
    expect((context as unknown as SandboxGlobals).__ops).toBeGreaterThan(OPS_PER_CHAR * len);
  });
});

// Adversarial shapes: each one made a legacy regex rescan the rest of the input per `import`.
const GROWTH_INPUTS: Record<string, (n: number) => string> = {
  'import ': n => 'import '.repeat(n),
  'import x\\n': n => 'import x\n'.repeat(n),
  'import type x\\n': n => 'import type x\n'.repeat(n),
  '{-heavy clause': n => `import ${'{'.repeat(n)} from 'x'\n`,
};
const OPS_PER_CHAR = 32;
const CEILING_MS = 250;

function legacyPipeline(code: string): string {
  const stripped = legacyStrip(code);
  legacyRelative(stripped);
  return legacyRewrite(stripped);
}

async function bestOf3(run: () => unknown): Promise<number> {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    await run();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

describe('growth: the emitted script stays linear on adversarial input', () => {
  for (const [name, make] of Object.entries(GROWTH_INPUTS)) {
    it(`scans at most ${OPS_PER_CHAR} chars per input char for "${name}" up to n=32000`, async () => {
      for (const n of [2000, 4000, 8000, 16000, 32000]) {
        const code = make(n);
        const sandbox = bootSandbox({ countOps: true });
        sandbox.globals.__ops = 0;
        await sandbox.render(code);
        expect(sandbox.globals.__ops, `n=${n}`).toBeLessThanOrEqual(OPS_PER_CHAR * code.length);
      }
    });

    it(`renders "${name}" at n=16000 under ${CEILING_MS}ms`, async () => {
      const code = make(16000);
      const ms = await bestOf3(() => bootSandbox().render(code));
      expect(ms).toBeLessThan(CEILING_MS);
    });
  }

  it('control: the legacy regexes exceed the ceiling at n=16000', async () => {
    const ms = await bestOf3(() => legacyPipeline(GROWTH_INPUTS['import x\\n'](16000)));
    expect(ms).toBeGreaterThan(CEILING_MS);
  });
});
