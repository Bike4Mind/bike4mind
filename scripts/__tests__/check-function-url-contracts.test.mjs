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
 * Behavior tests for scripts/check-function-url-contracts.mjs, scan 4 of
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

  it('blanks a comment after a regex literal holding a stray quote', () => {
    const source =
      'const re = /What\'s New/i;\n// TODO: defineLambdaRoute(c, f)\nconst r2 = /say "hi/;\n// defineLambdaRoute(c, f)';
    const clean = stripComments(source);
    expect(clean).toHaveLength(source.length);
    expect(clean).not.toContain('defineLambdaRoute');
    expect(clean).toContain("/What's New/i");
  });

  it.each([
    ['a paired quote and a trailing comment', "const q = /[\"']/; // don't keep defineLambdaRoute(c, f)"],
    ['a stray backtick', 'const fence = /```/g;\n// defineLambdaRoute(c, f)'],
    ['a /* in a character class', 'const glob = /[/*]/;\n// defineLambdaRoute(c, f)'],
    ['a // in a character class', "const re = /['//]/; // defineLambdaRoute(c, f)"],
  ])('blanks a comment after a regex literal with %s', (_name, source) => {
    const clean = stripComments(source);
    expect(clean).toHaveLength(source.length);
    expect(clean).not.toContain('defineLambdaRoute');
    expect(clean.slice(0, source.indexOf(';') + 1)).toBe(source.slice(0, source.indexOf(';') + 1));
  });

  it('keeps real code after a regex that holds // and a quote', () => {
    const source = "const re = /['//]/; export const handler = defineLambdaRoute(c, f);\n";
    expect(stripComments(source)).toBe(source);
  });

  it.each([
    ['a [///] class', 'const re = /[///]/; export const h = defineLambdaRoute(c, f);\n'],
    ['escaped slashes', 'const re = /\\/\\//; export const h = defineLambdaRoute(c, f);\n'],
    ['a regex after return', 'function f(s) { return /[/*]/.test(s); }\nexport const h = defineLambdaRoute(c, f);\n'],
  ])('keeps real code after a regex with %s', (_name, source) => {
    expect(stripComments(source)).toBe(source);
  });

  it.each([
    ['a postfix ++', 'const a = n++ / 2; // defineLambdaRoute(c, f)'],
    ['a postfix --', 'const a = n-- / 2; // defineLambdaRoute(c, f)'],
    ['a non-null !', 'const a = total! / count; // defineLambdaRoute(c, f)'],
    ['a JSX closing tag', 'return <div>{x}</div>; // defineLambdaRoute(c, f)'],
    ['a block comment', 'const a = n++ / 2; /* defineLambdaRoute(c, f) */'],
  ])('blanks a comment after a division misread as a regex start by %s', (_name, source) => {
    const clean = stripComments(source);
    expect(clean).toHaveLength(source.length);
    expect(clean).not.toContain('defineLambdaRoute');
  });

  it('does not treat a commented-out declaration as code after a postfix division', () => {
    const source = "const q = (a) => a++ / 2; // new sst.aws.Function('Old', { url: true });";
    expect(stripComments(source)).not.toContain('sst.aws');
  });

  it('bounds an unterminated quote at end of file', () => {
    const source = "if (x) /What's New/.test(s); // TODO: defineLambdaRoute(c, f)";
    expect(stripComments(source)).not.toContain('defineLambdaRoute');
  });

  it('treats / as division after an identifier, a paren or a literal', () => {
    const source = "const a = b / c; const d = (e) / 2; const s = 'x' / 1; // gone";
    expect(stripComments(source)).toBe(source.replace('// gone', '       '));
  });

  it('handles a nested ${...} expression inside a template', () => {
    const source = 'const p = `${a / b} // kept`; // gone';
    const clean = stripComments(source);
    expect(clean).toContain('`${a / b} // kept`');
    expect(clean).not.toContain('gone');
    expect(clean).toHaveLength(source.length);
  });

  it('blanks a comment inside a template interpolation', () => {
    const source = 'const p = `${a /* gone */ + b}`;';
    const clean = stripComments(source);
    expect(clean).not.toContain('gone');
    expect(clean).toContain('${a ');
    expect(clean).toContain('+ b}`;');
    expect(clean).toHaveLength(source.length);
  });
});

describe('stripComments: astral characters', () => {
  it('keeps offsets aligned after an emoji', () => {
    const source = "const s = '\u{1F600}'; // note\nconst x = defineLambdaRoute(c, f);";
    const out = stripComments(source);
    expect(out).toHaveLength(source.length);
    expect(out).not.toContain('/');
    expect(out).not.toContain('note');
    expect(out).toContain('const x = defineLambdaRoute(c, f);');
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

  it('parses Function options that carry a quote-bearing regex', () => {
    const text = fnDeclaration([HANDLER, "  environment: { PATTERN: /What's New/ },", '  url: true,']);
    expect(scan(text)).toEqual({
      exposed: [{ file: 'infra/fn.ts', handler: 'apps/workers/src/thing.handler' }],
      problems: [],
    });
  });

  it.each([['}'], [']'], ['{'], ['('], [')']])('never reports clean when options hold a regex with %s', ch => {
    const cls = ch === ']' ? '\\]' : ch;
    const text = fnDeclaration([HANDLER, `  pattern: /[${cls}]/,`, '  url: true,']);
    expect(scan(text)).toEqual({
      exposed: [{ file: 'infra/fn.ts', handler: 'apps/workers/src/thing.handler' }],
      problems: [],
    });
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

describe('findUrlFunctions: shapes that hide a url', () => {
  it('reads a quoted key', () => {
    expect(scan(fnDeclaration([HANDLER, "  'url': true,"])).exposed).toHaveLength(1);
  });

  it('finds a second Function in the same file', () => {
    const text = `${fnDeclaration([HANDLER])}\n${fnDeclaration(["  handler: 'apps/workers/src/two.handler',", '  url: true,'])}`;
    expect(scan(text).exposed).toEqual([{ file: 'infra/fn.ts', handler: 'apps/workers/src/two.handler' }]);
  });

  it('merges a spread of a same-file const, later keys winning', () => {
    const shared = "const shared = { handler: 'apps/workers/src/thing.handler', url: true };\n";
    expect(scan(shared + fnDeclaration(['  ...shared,'])).exposed).toHaveLength(1);
    expect(scan(shared + fnDeclaration(['  ...shared,', '  url: false,'])).exposed).toEqual([]);
  });

  it('fails closed on a spread it cannot resolve', () => {
    const { exposed, problems } = scan(fnDeclaration(['  ...imported,', HANDLER]));
    expect(exposed).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("'...imported'");
  });

  it('fails closed on a computed key', () => {
    expect(scan(fnDeclaration([HANDLER, "  ['url']: true,"])).problems).toHaveLength(1);
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
    const io = virtualFs({
      [ENTRY]: "import { defineLambdaRoute } from './defineLambdaRoute';\nexport const h = defineLambdaRoute(c, f);",
    });
    expect(usesDefineLambdaRoute('/repo', ENTRY, io)).toBe(true);
  });

  it('passes when the call carries an explicit type-argument list', () => {
    const io = virtualFs({
      [ENTRY]:
        "import { defineLambdaRoute } from './defineLambdaRoute';\nexport const h = defineLambdaRoute<MyContract>(c, f);",
    });
    expect(usesDefineLambdaRoute('/repo', ENTRY, io)).toBe(true);
  });

  it('passes through a relative import, like tools.handler.ts -> tools.ts', () => {
    const io = virtualFs({
      [ENTRY]: "import { run } from './route';\nexport const handler = run;",
      'apps/workers/src/route.ts':
        "import { defineLambdaRoute } from './defineLambdaRoute';\nexport const run = defineLambdaRoute(c, f);",
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

  it('passes a call through an aliased import', () => {
    const io = virtualFs({
      [ENTRY]: "import { defineLambdaRoute as route } from './defineLambdaRoute';\nexport const h = route(c, f);",
    });
    expect(usesDefineLambdaRoute('/repo', ENTRY, io)).toBe(true);
  });

  it('does not follow a type-only import', () => {
    const io = virtualFs({
      [ENTRY]: "import type { Foo } from './routed';\nexport const handler = raw;",
      'apps/workers/src/routed.ts': 'export const h = defineLambdaRoute(c, f);',
    });
    expect(usesDefineLambdaRoute('/repo', ENTRY, io)).toBe(false);
  });

  it('follows a three-hop chain (the documented bound)', () => {
    const io = virtualFs({
      [ENTRY]: "export { x } from './a';",
      'apps/workers/src/a.ts': "export { x } from '@workers/b';",
      'apps/workers/src/b.ts': "export { x } from './c';",
      'apps/workers/src/c.ts': 'const h = defineLambdaRoute(c, f);',
    });
    expect(usesDefineLambdaRoute('/repo', ENTRY, io)).toBe(true);
  });

  it('routes the real CliToolHandler chain', () => {
    expect(usesDefineLambdaRoute(REPO_ROOT, 'apps/workers/src/cli/tools.handler.ts')).toBe(true);
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
const ROUTED_HANDLER =
  "import { defineLambdaRoute } from './defineLambdaRoute';\nexport const handler = defineLambdaRoute(c, f);";

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

  it('exits 1 when the only defineLambdaRoute is in a comment after a regex with an apostrophe', () => {
    const dir = writeTree({
      'infra/fn.ts': fnDeclaration([HANDLER, '  url: true,']),
      'apps/workers/src/thing.ts': `${RAW_HANDLER}\nconst datePattern = /What's New - [A-Za-z]+/i;\n// TODO: defineLambdaRoute(contract, handler)\n`,
    });
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stdout.trim()).toBe('apps/workers/src/thing.ts');
  });

  it.each([
    [
      'a paired quote and a trailing comment',
      "const quoteRe = /[\"']/; // don't forget defineLambdaRoute(contract, handler)",
    ],
    ['a stray backtick', 'const fence = /```/g;\n// defineLambdaRoute(contract, handler)'],
  ])('exits 1 when the only defineLambdaRoute is in a comment after a regex with %s', (_name, extra) => {
    const dir = writeTree({
      'infra/fn.ts': fnDeclaration([HANDLER, '  url: true,']),
      'apps/workers/src/thing.ts': `${RAW_HANDLER}\n${extra}\n`,
    });
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stdout.trim()).toBe('apps/workers/src/thing.ts');
  });

  it('still sees a Function URL declared after a /* inside a regex in infra', () => {
    const dir = writeTree({
      'infra/fn.ts': `const glob = /[/*]/;\n${fnDeclaration([HANDLER, '  url: true,'])}`,
      'apps/workers/src/thing.ts': RAW_HANDLER,
    });
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stdout.trim()).toBe('apps/workers/src/thing.ts');
  });

  it.each([
    ['a non-null !', 'const avg = total! / count; // defineLambdaRoute(contract, handler)'],
    ['a postfix ++', 'const avg = n++ / 2; // defineLambdaRoute(contract, handler)'],
    ['a postfix --', 'const avg = n-- / 2; // defineLambdaRoute(contract, handler)'],
    ['an unterminated quote at EOF', "if (x) /What's New/.test(s); // TODO: defineLambdaRoute(contract, handler)"],
  ])('exits 1 when the only defineLambdaRoute is in a comment after %s', (_name, extra) => {
    const dir = writeTree({
      'infra/fn.ts': fnDeclaration([HANDLER, '  url: true,']),
      'apps/workers/src/thing.ts': `${RAW_HANDLER}\n${extra}`,
    });
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stdout.trim()).toBe('apps/workers/src/thing.ts');
  });

  it('exits 1 for an imported .tsx whose only defineLambdaRoute is a comment after a JSX closing tag', () => {
    const dir = writeTree({
      'infra/fn.ts': fnDeclaration([HANDLER, '  url: true,']),
      'apps/workers/src/thing.ts': `${RAW_HANDLER}\nimport './view';\n`,
      'apps/workers/src/view.tsx':
        'export const V = () => {\n  return <div>{x}</div>; // TODO: defineLambdaRoute(contract, handler)\n};\n',
    });
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stdout.trim()).toBe('apps/workers/src/thing.ts');
  });

  it('does not report a commented-out Function after a postfix division', () => {
    const dir = writeTree({
      'infra/fn.ts':
        "export const q = (a) => a++ / 2; // new sst.aws.Function('Old', { handler: 'apps/workers/src/thing.handler', url: true });\n",
      'apps/workers/src/thing.ts': RAW_HANDLER,
    });
    expect(run(dir).status).toBe(0);
  });

  it('exits 1 for a url Function whose options hold a regex with a closing brace', () => {
    const dir = writeTree({
      'infra/fn.ts': fnDeclaration([HANDLER, '  pattern: /[}]/,', '  url: true,']),
      'apps/workers/src/thing.ts': RAW_HANDLER,
    });
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stdout.trim()).toBe('apps/workers/src/thing.ts');
  });

  it('passes a generic defineLambdaRoute<C>(...) call', () => {
    const dir = writeTree({
      'infra/fn.ts': fnDeclaration([HANDLER, '  url: true,']),
      'apps/workers/src/thing.ts': 'export const handler = defineLambdaRoute<MyContract>(c, f);\n',
    });
    expect(run(dir).status).toBe(0);
  });

  it('passes a real defineLambdaRoute call on the line of a regex holding //', () => {
    const dir = writeTree({
      'infra/fn.ts': fnDeclaration([HANDLER, '  url: true,']),
      'apps/workers/src/thing.ts': "const re = /['//]/; export const handler = defineLambdaRoute(c, f);\n",
    });
    expect(run(dir).status).toBe(0);
  });

  it('passes the CliToolHandler shape: the wrapper imports the routed module', () => {
    const dir = writeTree({
      'infra/fn.ts': fnDeclaration(ROUTER_URL.map((l) => l.replace('thing.handler', 'thing.handler.handler'))),
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

  it('reports a symlinked invocation the same as a physical one', () => {
    const dir = writeTree({
      'infra/fn.ts': fnDeclaration([HANDLER, '  url: true,']),
      'apps/workers/src/thing.ts': RAW_HANDLER,
    });
    const linkedScript = path.join(dir, 'link.mjs');
    fs.symlinkSync(SCRIPT, linkedScript);
    const r = spawnSync(process.execPath, [linkedScript, dir], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stdout.trim()).toBe('apps/workers/src/thing.ts');
  });

  it('exits 2 on a spread it cannot resolve', () => {
    const dir = writeTree({ 'infra/fn.ts': fnDeclaration(['  ...imported,', HANDLER]) });
    expect(run(dir).status).toBe(2);
  });

  it('exits 2 when infra/ is missing', () => {
    const dir = writeTree({ 'README.md': 'no infra here\n' });
    const r = run(dir);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Infra directory not found');
  });
});

describe('unreadable options elements', () => {
  const RAW_FN = "new sst.aws.Function('F', {";

  it.each([
    ['shorthand url', `const url = true;\n${RAW_FN}\n  handler: 'apps/workers/src/raw.handler',\n  url,\n});`, 'url'],
    [
      'getter url',
      `${RAW_FN}\n  handler: 'apps/workers/src/raw.handler',\n  get url() { return true; },\n});`,
      'get url()',
    ],
  ])('reports a %s instead of dropping it', (_label, text, element) => {
    const { exposed, problems } = scan(text);
    expect(exposed).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`cannot inspect '${element}`);
  });

  it('exits 2 for a shorthand url end to end', () => {
    const dir = writeTree({
      'infra/fn.ts': `const url = true;\n${RAW_FN}\n  handler: 'apps/workers/src/raw.handler',\n  url,\n});`,
      'apps/workers/src/raw.ts': RAW_HANDLER,
    });
    expect(run(dir).status).toBe(2);
  });

  it('reports a non-identifier spread', () => {
    const { problems } = scan(`${RAW_FN}\n  handler: 'apps/workers/src/raw.handler',\n  ...opts.more,\n});`);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('cannot inspect a spread or computed key');
  });
});

describe('same-file spread resolution', () => {
  const spreadInto = decls => `${decls}\nexport const f = new sst.aws.Function('F', { ...CFG });`;

  it('fails closed when the spread name is declared twice', () => {
    const { exposed, problems } = scan(
      spreadInto(
        "const CFG = { handler: 'apps/workers/src/raw.handler' };\nfunction g() { const CFG = { handler: 'apps/workers/src/raw.handler', url: true }; }"
      )
    );
    expect(exposed).toEqual([]);
    expect(problems[0]).toContain("cannot resolve spread '...CFG'");
  });

  it('resolves a single declaration whose annotation contains an arrow type', () => {
    const { exposed, problems } = scan(
      spreadInto("const CFG: Record<string, () => void> = { handler: 'apps/workers/src/raw.handler', url: true };")
    );
    expect(problems).toEqual([]);
    expect(exposed).toEqual([{ file: 'infra/fn.ts', handler: 'apps/workers/src/raw.handler' }]);
  });

  it('still resolves the real agent-executor spread', () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, 'infra/agentExecutor.ts'), 'utf8');
    expect(findUrlFunctions([{ file: 'infra/agentExecutor.ts', text }]).problems).toEqual([]);
  });

  it('exits 2 with ::error:: when a crash happens inside main() (recursive spread)', () => {
    const dir = writeTree({
      'infra/fn.ts': "const shared = { ...shared };\nnew sst.aws.Function('F', { ...shared });",
    });
    const r = run(dir);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('::error::Function URL contract scan crashed');
    expect(r.stdout).toBe('');
  });
});

describe('inline type imports', () => {
  const ENTRY = 'apps/workers/src/entry.ts';
  const routed = { 'apps/workers/src/routed.ts': 'export const h = defineLambdaRoute(c, f);' };

  it.each([
    ['inline type specifier', "import { type Foo } from './routed';\nexport const handler = raw;"],
    ['export type', "export type { Foo } from './routed';\nexport const handler = raw;"],
  ])('does not follow an %s', (_label, entry) => {
    expect(usesDefineLambdaRoute('/repo', ENTRY, virtualFs({ [ENTRY]: entry, ...routed }))).toBe(false);
  });

  it('follows a list that mixes a type with a value import', () => {
    const io = virtualFs({ [ENTRY]: "import { type Foo, h } from './routed';\nexport const handler = h;", ...routed });
    expect(usesDefineLambdaRoute('/repo', ENTRY, io)).toBe(true);
  });
});

describe('real infra declarations', () => {
  it('discovers the CliToolHandler Function URL', () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, 'infra/cliToolHandler.ts'), 'utf8');
    expect(findUrlFunctions([{ file: 'infra/cliToolHandler.ts', text }]).exposed).toEqual([
      { file: 'infra/cliToolHandler.ts', handler: 'apps/workers/src/cli/tools.handler.handler' },
    ]);
  });
});
