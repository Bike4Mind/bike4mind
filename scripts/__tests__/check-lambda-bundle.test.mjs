import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SST_BUILTIN_EXTERNAL,
  parseAlwaysExternal,
  listInfraSources,
  collectHandlers,
  resolveHandlerFile,
  isOverlayHandler,
  planEntryPoints,
  dedupeMessages,
} from '../check-lambda-bundle.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const dirs = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

function tempTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-bundle-'));
  dirs.push(root);
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }
  return root;
}

// A fake `exists` keyed off a set, so the split tests do not need a tree on disk.
const existsIn = present => p => present.has(path.relative(repoRoot, p));

describe('parseAlwaysExternal', () => {
  it('reads the literals out of the sst.config.ts declaration', () => {
    const source = `
      const ALWAYS_EXTERNAL = ['isolated-vm', '@huggingface/transformers', 'onnxruntime-node'];
      $transform(sst.aws.Function, args => args);
    `;
    expect(parseAlwaysExternal(source)).toEqual(['isolated-vm', '@huggingface/transformers', 'onnxruntime-node']);
  });

  it('handles a multi-line declaration', () => {
    const source = "const ALWAYS_EXTERNAL = [\n  'a',\n  'b',\n];";
    expect(parseAlwaysExternal(source)).toEqual(['a', 'b']);
  });

  // Losing the declaration must stop the guard, not silently drop the externals
  // and redden every handler that imports a native addon.
  it('throws a pointed error when the declaration is gone', () => {
    expect(() => parseAlwaysExternal('const SOMETHING_ELSE = [];')).toThrow(/ALWAYS_EXTERNAL/);
  });

  it('agrees with the live sst.config.ts', () => {
    const live = parseAlwaysExternal(fs.readFileSync(path.join(repoRoot, 'sst.config.ts'), 'utf8'));
    expect(live).toContain('isolated-vm');
    expect(live.length).toBeGreaterThan(0);
  });
});

describe('collectHandlers', () => {
  it('collects literals across files, dedupes, and records where each was declared', () => {
    const read = f =>
      ({
        'a.ts': "queue.subscribe({ handler: 'apps/client/server/one.handler' });",
        'b.ts':
          "new sst.aws.Function('f', { handler: 'apps/client/server/one.handler' });\nconst g = { handler: \"apps/client/server/two.func\" };",
      })[f];
    expect(collectHandlers(['a.ts', 'b.ts'], read)).toEqual([
      { handler: 'apps/client/server/one.handler', declaredIn: 'a.ts' },
      { handler: 'apps/client/server/two.func', declaredIn: 'b.ts' },
    ]);
  });

  // A computed handler would vanish from the guard with nothing to show for it.
  it('throws when a handler is not a string literal', () => {
    const read = () => 'const f = { handler: handlerPath };';
    expect(() => collectHandlers(['a.ts'], read)).toThrow(/not a string literal/);
  });
});

describe('listInfraSources', () => {
  it('skips tests, which declare handlers that no Lambda deploys', () => {
    const root = tempTree({
      'queues.ts': '',
      'waf/rules.ts': '',
      'waf.test.ts': '',
      '__tests__/queues.test.ts': '',
      'notes.md': '',
    });
    expect(
      listInfraSources(root)
        .map(f => path.relative(root, f))
        .sort()
    ).toEqual(['queues.ts', path.join('waf', 'rules.ts')]);
  });
});

describe('resolveHandlerFile', () => {
  it('strips the export name and finds the source file', () => {
    const exists = existsIn(new Set(['apps/client/server/cron/warmer.ts']));
    expect(resolveHandlerFile(repoRoot, 'apps/client/server/cron/warmer.dispatch', exists)).toBe(
      'apps/client/server/cron/warmer.ts'
    );
  });

  it('splits on the last dot, so a dotted export name still resolves', () => {
    const exists = existsIn(new Set(['apps/client/server/cron/a.b.ts']));
    expect(resolveHandlerFile(repoRoot, 'apps/client/server/cron/a.b.handler', exists)).toBe(
      'apps/client/server/cron/a.b.ts'
    );
  });

  it('returns null when no extension matches', () => {
    expect(resolveHandlerFile(repoRoot, 'apps/client/server/gone.handler', existsIn(new Set()))).toBeNull();
  });
});

describe('planEntryPoints', () => {
  const handlers = [
    { handler: 'apps/client/server/real.handler', declaredIn: 'infra/queues.ts' },
    { handler: 'apps/client/server/premium-generated/bobRunWorker.dispatch', declaredIn: 'infra/queues.ts' },
    { handler: 'apps/client/server/typo.handler', declaredIn: 'infra/cron.ts' },
  ];

  it('bundles what exists, skips overlay-only handlers, and fails the rest', () => {
    const exists = existsIn(new Set(['apps/client/server/real.ts']));
    const { entries, skipped, missing } = planEntryPoints(repoRoot, handlers, exists);
    expect(entries).toEqual([
      { handler: 'apps/client/server/real.handler', file: 'apps/client/server/real.ts', declaredIn: 'infra/queues.ts' },
    ]);
    expect(skipped.map(s => s.handler)).toEqual(['apps/client/server/premium-generated/bobRunWorker.dispatch']);
    expect(missing.map(m => m.handler)).toEqual(['apps/client/server/typo.handler']);
  });

  // The overlay skip is a path rule, not a blanket "missing is fine" rule. An
  // overlay handler whose source IS present gets bundled like any other.
  it('bundles an overlay handler once its source is hydrated', () => {
    const exists = existsIn(new Set(['apps/client/server/premium-generated/bobRunWorker.ts']));
    const { entries, skipped } = planEntryPoints(repoRoot, [handlers[1]], exists);
    expect(entries).toHaveLength(1);
    expect(skipped).toHaveLength(0);
  });

  it('agrees with the live infra/, where every non-overlay handler resolves', () => {
    const live = collectHandlers(listInfraSources(path.join(repoRoot, 'infra')));
    const { entries, missing } = planEntryPoints(repoRoot, live);
    expect(missing).toEqual([]);
    expect(entries.length).toBeGreaterThan(50);
  });
});

describe('isOverlayHandler', () => {
  it('matches the generated overlay path and nothing else', () => {
    expect(isOverlayHandler('apps/client/server/premium-generated/bobRunWorker.dispatch')).toBe(true);
    expect(isOverlayHandler('apps/client/server/queueHandlers/agentExecutor.handler')).toBe(false);
  });
});

describe('dedupeMessages', () => {
  it('collapses the same failure reported once per entry point and counts the reach', () => {
    const at = { file: 'node_modules/x/index.js', line: 1 };
    expect(
      dedupeMessages([
        { text: 'No matching export for "hasOwn"', location: at },
        { text: 'No matching export for "hasOwn"', location: at },
        { text: 'Could not resolve "y"', location: null },
      ])
    ).toEqual([
      { text: 'No matching export for "hasOwn"', where: 'node_modules/x/index.js:1', count: 2 },
      { text: 'Could not resolve "y"', where: '', count: 1 },
    ]);
  });
});

describe('SST_BUILTIN_EXTERNAL', () => {
  it('carries the two externals sst adds to every node Function', () => {
    expect(SST_BUILTIN_EXTERNAL).toEqual(['sharp', 'pg-native']);
  });
});
