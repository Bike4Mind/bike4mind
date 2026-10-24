import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ADAPTER_FILE,
  findUrlFunctions,
  resolveHandlerFile,
  stripComments,
  usesDefineLambdaRoute,
} from '../check-function-url-contracts.mjs';

/**
 * Behavior tests for scripts/check-function-url-contracts.mjs, the third scan of
 * scripts/check-contract-gate.sh. The pure helpers are tested directly; the
 * structural outcomes (missing handler, overlay handler, missing infra/) run the
 * real CLI against a throwaway tree.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-function-url-contracts.mjs');

const sandboxes = [];
afterEach(() => {
  while (sandboxes.length) fs.rmSync(sandboxes.pop(), { recursive: true, force: true });
});

function scan(text, file = 'infra/fn.ts') {
  return findUrlFunctions([{ file, text }]);
}

// `new sst.aws.Function('F', {...})` with the given body lines.
function fnDeclaration(lines) {
  return ["export const f = new sst.aws.Function('F', {", ...lines, '});'].join('\n');
}

const HANDLER = "  handler: 'apps/workers/src/thing.handler',";

// An options literal whose `url` holds a nested object and a template literal:
// brace matching must survive both.
const ROUTER_URL = [
  HANDLER,
  '  url: { router: { instance: router, path: `${routePrefix}/api/ai/v1/thing` } },',
  "  environment: { A: '1', B: { C: '2' }, D: [1, 2] },",
];

describe('stripComments', () => {
  it('blanks line and block comments, preserving offsets and newlines', () => {
    const source = 'a // gone\nb /* gone\ntoo */ c';
    const clean = stripComments(source);
    expect(clean).toHaveLength(source.length);
    expect(clean).not.toContain('gone');
    expect(clean).not.toContain('/*');
    expect(clean).not.toContain('//');
    expect(clean.split('\n')).toHaveLength(3);
    expect(clean.trimEnd().endsWith('c')).toBe(true);
  });

  it('keeps string and template literals intact', () => {
    expect(stripComments("const a = 'http://x';")).toBe("const a = 'http://x';");
    expect(stripComments('const a = `/* not a comment */`;')).toBe('const a = `/* not a comment */`;');
  });

  it('handles a nested ${...} expression inside a template', () => {
    const source = 'const p = `${a / b} // kept`; // gone';
    const clean = stripComments(source);
    expect(clean).toContain('`${a / b} // kept`');
    expect(clean).not.toContain('gone');
    expect(clean).toHaveLength(source.length);
  });
});

describe('findUrlFunctions', () => {
  it('detects url: true', () => {
    expect(scan(fnDeclaration([HANDLER, '  url: true,']))).toEqual({
      exposed: [{ file: 'infra/fn.ts', handler: 'apps/workers/src/thing.handler' }],
      problems: [],
    });
  });

  it('detects url: { router: ... } with nested objects and a template path', () => {
    expect(scan(fnDeclaration(ROUTER_URL)).exposed).toEqual([
      { file: 'infra/fn.ts', handler: 'apps/workers/src/thing.handler' },
    ]);
  });

  it('ignores url: false and url: undefined', () => {
    expect(scan(fnDeclaration([HANDLER, '  url: false,'])).exposed).toEqual([]);
    expect(scan(fnDeclaration([HANDLER, '  url: undefined,'])).exposed).toEqual([]);
  });

  it('ignores a Function that declares no url', () => {
    expect(scan(fnDeclaration([HANDLER])).exposed).toEqual([]);
  });

  it('ignores the same declaration inside a comment', () => {
    const source = [
      "// new sst.aws.Function('Gone', { handler: 'x.h', url: true });",
      "/* new sst.aws.Function('Gone', { handler: 'x.h', url: true }) */",
    ].join('\n');
    expect(scan(source)).toEqual({ exposed: [], problems: [] });
  });

  it('ignores a commented-out url property', () => {
    const source = fnDeclaration([HANDLER, '  // url: true,', '  /* url: { router: r }, */']);
    expect(scan(source)).toEqual({ exposed: [], problems: [] });
  });

  it('reports a non-literal handler as a structural problem', () => {
    const { exposed, problems } = scan(fnDeclaration(['  url: true,', '  handler: pickHandler(),']));
    expect(exposed).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('non-literal');
  });

  it('reports a url Function with no handler', () => {
    const { problems } = scan(fnDeclaration(['  url: true,']));
    expect(problems[0]).toContain("declares no 'handler'");
  });

  it('reports options that are not an object literal', () => {
    const { problems } = scan("export const f = new sst.aws.Function('F', sharedOptions);");
    expect(problems[0]).toContain('object literal');
  });
});

describe('resolveHandlerFile', () => {
  it('strips the export name and finds each supported extension', () => {
    const existing = new Set(['apps/workers/src/a.ts']);
    expect(resolveHandlerFile('/repo', 'apps/workers/src/a.handler', p => existing.has(p))).toBe(
      'apps/workers/src/a.ts'
    );
  });

  it('returns null when no source file matches', () => {
    expect(resolveHandlerFile('/repo', 'apps/workers/src/missing.handler', () => false)).toBeNull();
  });
});

// @workers/* maps to apps/workers/src/*; every other alias is unresolved (fails closed).
function virtualFs(files) {
  return {
    exists: file => Object.hasOwn(files, file),
    read: file => {
      if (!Object.hasOwn(files, file)) throw new Error(`ENOENT ${file}`);
      return files[file];
    },
  };
}

describe('usesDefineLambdaRoute', () => {
  const ENTRY = 'apps/workers/src/entry.ts';

  it('passes when the entry calls defineLambdaRoute directly', () => {
    const io = virtualFs({ [ENTRY]: "import { defineLambdaRoute } from './defineLambdaRoute';\nexport const h = defineLambdaRoute(c, f);" });
    expect(usesDefineLambdaRoute('/repo', ENTRY, io)).toBe(true);
  });

  it('passes through a relative import, like tools.handler.ts -> tools.ts', () => {
    const io = virtualFs({
      [ENTRY]: "import { run } from './route';\nexport const handler = run;",
      'apps/workers/src/route.ts': "import { defineLambdaRoute } from './defineLambdaRoute';\nexport const run = defineLambdaRoute(c, f);",
    });
    expect(usesDefineLambdaRoute('/repo', ENTRY, io)).toBe(true);
  });

  it('passes through the @workers/* alias', () => {
    const io = virtualFs({
      [ENTRY]: "import { run } from '@workers/cli/route';\nexport const handler = run;",
      'apps/workers/src/cli/route.ts': 'const h = defineLambdaRoute(c, f);',
    });
    expect(usesDefineLambdaRoute('/repo', ENTRY, io)).toBe(true);
  });

  it('fails for a handler that imports only internalErrorResult from the adapter', () => {
    const io = virtualFs({
      [ENTRY]: `import { internalErrorResult } from '@workers/cli/defineLambdaRoute';\nexport const handler = e => internalErrorResult(e);`,
      [ADAPTER_FILE]: 'export function defineLambdaRoute(c, f) { return f; }',
    });
    expect(usesDefineLambdaRoute('/repo', ENTRY, io)).toBe(false);
  });

  it('does not accept a commented-out call', () => {
    const io = virtualFs({ [ENTRY]: '// defineLambdaRoute(c, f)\nexport const h = raw;' });
    expect(usesDefineLambdaRoute('/repo', ENTRY, io)).toBe(false);
  });

  it('stops at the import depth bound', () => {
    const io = virtualFs({
      [ENTRY]: "export { x } from './a';",
      'apps/workers/src/a.ts': "export { x } from './b';",
      'apps/workers/src/b.ts': "export { x } from './c';",
      'apps/workers/src/c.ts': "export { x } from './d';",
      'apps/workers/src/d.ts': 'const h = defineLambdaRoute(c, f);',
    });
    expect(usesDefineLambdaRoute('/repo', ENTRY, io)).toBe(false);
  });

  it('fails closed on an unresolvable alias', () => {
    const io = virtualFs({
      [ENTRY]: "export { defineLambdaRoute } from '@server/cli/defineLambdaRoute';",
      'apps/client/server/cli/defineLambdaRoute.ts': 'export const defineLambdaRoute = () => {};',
    });
    expect(usesDefineLambdaRoute('/repo', ENTRY, io)).toBe(false);
  });

  it('ADAPTER_FILE still exists in this repo', () => {
    expect(fs.existsSync(path.join(REPO_ROOT, ADAPTER_FILE))).toBe(true);
  });
});

function writeTree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fn-url-contracts-'));
  sandboxes.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return dir;
}

function run(root) {
  const r = spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const RAW_HANDLER = "export const handler = async () => ({ statusCode: 200, body: '' });";
const ROUTED_HANDLER = "import { defineLambdaRoute } from './defineLambdaRoute';\nexport const handler = defineLambdaRoute(c, f);";

describe('main', () => {
  it('exits 0 on a clean tree', () => {
    const dir = writeTree({ 'infra/fn.ts': fnDeclaration([HANDLER, '  url: false,']) });
    expect(run(dir).status).toBe(0);
  });

  it('exits 1 and names the handler file when defineLambdaRoute is never reached', () => {
    const dir = writeTree({
      'infra/fn.ts': fnDeclaration([HANDLER, '  url: true,']),
      'apps/workers/src/thing.ts': RAW_HANDLER,
    });
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stdout.trim()).toBe('apps/workers/src/thing.ts');
  });

  it('passes the CliToolHandler shape: the wrapper imports the routed module', () => {
    const dir = writeTree({
      'infra/fn.ts': fnDeclaration(ROUTER_URL),
      'apps/workers/src/thing.handler.ts': "import { run } from './thing';\nexport const handler = run;",
      'apps/workers/src/thing.ts': ROUTED_HANDLER,
      [ADAPTER_FILE]: 'export function defineLambdaRoute(c, f) { return f; }',
    });
    expect(run(dir).status).toBe(0);
  });

  it('exits 2 when the handler file does not exist', () => {
    const dir = writeTree({ 'infra/fn.ts': fnDeclaration([HANDLER, '  url: true,']) });
    const r = run(dir);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('no source file');
  });

  it('skips a premium-generated overlay handler', () => {
    const dir = writeTree({
      'infra/fn.ts': fnDeclaration(["  handler: 'premium-generated/x.handler',", '  url: true,']),
    });
    expect(run(dir).status).toBe(0);
  });

  it('exits 2 when infra/ is missing', () => {
    const dir = writeTree({ 'README.md': 'no infra here\n' });
    const r = run(dir);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Infra directory not found');
  });
});
