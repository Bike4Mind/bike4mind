import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  conservativeSeeds, discoverRelated, isUntraceableReader, listDiff, parseDiff, planClientRelated, runRelated,
} from '../ci-related-tests.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = 'apps/client/app/foo.ts';

describe('client related eligibility', () => {
  it('sorts and deduplicates ordinary client source changes', () => {
    expect(planClientRelated([source, 'apps/client/pages/api/[id].ts', source])).toEqual({
      mode: 'related', files: ['apps/client/app/foo.ts', 'apps/client/pages/api/[id].ts'],
    });
  });
  it.each([
    null, [], [source, 'b4m-core/common/src/index.ts'], [source, 'README.md'],
    ['apps/client/vitest.config.mts'], ['apps/client/vitest.setup.ts'], ['apps/client/__mocks__/foo.ts'],
    ['apps/client/app/test-utils/foo.ts'], ['apps/client/tsconfig.json'], ['apps/client/package.json'],
    ['apps/client/public/foo.json'], ['apps/client/../outside.ts'], [42],
  ])('fails open for %j', files => expect(planClientRelated(files)).toEqual({ mode: 'full' }));
  it('rejects a deletion or uncertain status', () => expect(planClientRelated([source], false)).toEqual({ mode: 'full' }));
});

describe('deterministic PR diff', () => {
  it('preserves unusual filenames without interpreting shell text', () => {
    expect(parseDiff('M\0z space.ts\0A\0a\n$(echo nope).ts\0')).toEqual({
      files: ['a\n$(echo nope).ts', 'z space.ts'], relatedSafe: true,
    });
  });
  it('disables related selection for deletions (including no-renames moves)', () => {
    expect(parseDiff('D\0old.ts\0A\0new.ts\0').relatedSafe).toBe(false);
  });
  it.each(['M\0a', 'R100\0old\0new\0', 'M\0'])('rejects malformed diff %j', text => expect(() => parseDiff(text)).toThrow());
  const env = { GITHUB_EVENT_NAME: 'pull_request', PR_BASE_SHA: 'a'.repeat(40), PR_HEAD_SHA: 'b'.repeat(40) };
  it('uses the merge base, explicit head and NUL-delimited no-renames diff', () => {
    const git = vi.fn().mockReturnValueOnce(`${'c'.repeat(40)}\n`).mockReturnValueOnce(`M\0${source}\0`);
    expect(listDiff(env, git)).toEqual({ files: JSON.stringify([source]), 'related-safe': 'true' });
    expect(git.mock.calls[1][0]).toEqual(['diff', '--no-renames', '--name-status', '-z', 'c'.repeat(40), 'b'.repeat(40)]);
  });
  it.each([{ ...env, FORCE_FULL: 'true' }, { ...env, GITHUB_EVENT_NAME: 'push' }, { ...env, PR_HEAD_SHA: '--oops' }])(
    'uses a full plan for pushes, ci:full and bad refs', input => {
      expect(listDiff(input, vi.fn())).toEqual({ files: '', 'related-safe': 'false' });
    }
  );
  it('fails open when git cannot resolve the diff', () => {
    expect(listDiff(env, () => { throw new Error('missing history'); }).files).toBe('');
  });
});

describe('non-import dependency backstop', () => {
  it.each([
    "import { readFile } from 'node:fs/promises'", "const fs = require('fs')", "import fs from 'fs-extra'",
    "import { readSource } from './helper'; readFileSync(path)", "import(variable)", "require(variable)",
    "import.meta.glob('./*.ts')", "import { execFileSync } from 'node:child_process'",
    'import(`./${name}.ts`)',
  ])('seeds reader modules and dynamic dependencies: %s', text => expect(isUntraceableReader(text)).toBe(true));
  it.each(["import { x } from '@bike4mind/common'", "import('./component')", "require('./component')"])(
    'does not treat resolved imports as readers: %s', text => expect(isUntraceableReader(text)).toBe(false)
  );
  it('includes helper modules, not just test files', () => {
    expect(conservativeSeeds(['test-utils/helper.ts', 'component.tsx', 'image.png'], file => file.endsWith('helper.ts') ? "import fs from 'fs'" : '')).toEqual(['test-utils/helper.ts']);
  });
  it('scans external test helpers and explicit source readers without seeding production I/O', () => {
    const runner = readFileSync(resolve(root, 'scripts/ci-related-tests.mjs'), 'utf8');
    expect(runner).toContain("git(['ls-files', '-z'], root)");
    const sources = {
      'packages/server-utils/test-utils/readSource.ts': "import fs from 'node:fs'",
      'packages/server-utils/src/testHelpers.ts': "import fs from 'node:fs'",
      'packages/server-utils/src/readSource.ts': "readFileSync(resolve(root, 'component.tsx'), 'utf8')",
      'apps/client/server/storage.ts': "import fs from 'node:fs'; export const read = path => fs.readFileSync(path)",
      [source]: "import { x } from '@bike4mind/common'",
    };
    expect(conservativeSeeds(Object.keys(sources), file => sources[file])).toEqual([
      'packages/server-utils/src/readSource.ts', 'packages/server-utils/src/testHelpers.ts', 'packages/server-utils/test-utils/readSource.ts',
    ]);
  });
});

describe('related discovery', () => {
  const test = { moduleId: '/client/foo.test.ts', project: { name: 'node' } };
  const reader = { moduleId: '/client/fs.test.ts', project: { name: 'jsdom' } };
  it('preserves exact project specifications and unions reader seeds', async () => {
    const vitest = { config: {}, globTestSpecifications: async () => [test, reader], getRelevantTestSpecifications: vi.fn().mockResolvedValueOnce([test]).mockResolvedValueOnce([test, reader]) };
    expect(await discoverRelated(vitest, ['/client/[id].ts'], ['/client/helper.ts'])).toEqual([test, reader]);
    expect(vitest.config.related).toEqual(['/client/[id].ts', '/client/helper.ts']);
  });
  it('does not let reader matches hide an untraceable changed source', async () => {
    const vitest = { config: {}, globTestSpecifications: async () => [test, reader], getRelevantTestSpecifications: async () => [] };
    await expect(discoverRelated(vitest, ['/client/unknown.ts'], [reader.moduleId])).rejects.toThrow('untraceable');
  });
  it('allows zero lane matches only with positive coverage from the other lane', async () => {
    const vitest = { config: {}, globTestSpecifications: async () => [test], getRelevantTestSpecifications: async () => [] };
    const traceOtherLane = vi.fn(async () => true);
    expect(await discoverRelated(vitest, ['/client/ui.tsx'], [], traceOtherLane)).toEqual([]);
    expect(traceOtherLane).toHaveBeenCalledWith('/client/ui.tsx');
    await expect(discoverRelated(vitest, ['/client/unknown.ts'], [], async () => false)).rejects.toThrow('untraceable');
  });
  it('fails open if a changed test disappears from the related result', async () => {
    const vitest = { config: {}, globTestSpecifications: async () => [test, reader], getRelevantTestSpecifications: vi.fn().mockResolvedValueOnce([test]).mockResolvedValueOnce([reader]) };
    await expect(discoverRelated(vitest, [test.moduleId], [])).rejects.toThrow('changed test not selected');
  });
  it('falls back directly to the full script, retaining the shard and failure status', async () => {
    const run = vi.fn().mockReturnValue({ status: 7 });
    expect(await runRelated({ plan: null, script: 'test', shard: '--shard=2/3', root, run })).toBe(7);
    expect(run.mock.calls[0].slice(0, 2)).toEqual(['pnpm', ['--filter', '@bike4mind/client', 'test', '--shard=2/3']]);
  });
  it('pins NODE_ENV to test for the fallback when the caller left it unset', async () => {
    const previous = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      const run = vi.fn().mockReturnValue({ status: 0 });
      await runRelated({ plan: null, script: 'test', root, run });
      expect(run.mock.calls[0][2].env.NODE_ENV).toBe('test');
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });
  it('rejects executable shard strings before invoking a command', async () => {
    await expect(runRelated({ script: 'test', shard: '--shard=1/3;echo bad' })).rejects.toThrow('invalid shard');
  });
  it('probes the opposite lane before skipping an empty selection and closes both contexts', async () => {
    const file = 'apps/client/app/hooks/useDebouncedValue.ts';
    const spec = { moduleId: resolve(root, 'apps/client/app/hooks/useDebouncedValue.test.ts') };
    const close = vi.fn();
    const run = vi.fn();
    const execute = vi.fn();
    const create = vi.fn(async () => {
      const integration = process.env.CLIENT_TEST_LANE === 'integration';
      return {
        config: {}, close, runTestSpecifications: execute,
        globTestSpecifications: async () => [spec],
        getRelevantTestSpecifications: async () => integration ? [] : [spec],
      };
    });
    const previous = process.env.CLIENT_TEST_LANE;
    try {
      expect(await runRelated({ plan: { mode: 'related', files: [file] }, script: 'test:integration', root, create, run })).toBe(0);
      expect(create).toHaveBeenCalledTimes(2);
      expect(close).toHaveBeenCalledTimes(2);
      expect(process.env.CLIENT_TEST_LANE).toBe('integration');
      expect(execute).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.CLIENT_TEST_LANE;
      else process.env.CLIENT_TEST_LANE = previous;
    }
  });
  it.each([
    { testModules: [{ ok: () => false }], unhandledErrors: [] },
    { testModules: [], unhandledErrors: [new Error('unhandled')] },
  ])('propagates selected failures without retrying as a full suite', async result => {
    const file = 'apps/client/app/constants/apiKeyScopeEndpoints.generated.test.ts';
    const spec = { moduleId: resolve(root, file), project: { name: 'node' } };
    const close = vi.fn();
    const run = vi.fn();
    const create = vi.fn(async () => {
      expect(process.env.CLIENT_TEST_LANE).toBe('integration');
      return {
        config: {}, close, standalone: async () => {},
        globTestSpecifications: async () => [spec],
        getRelevantTestSpecifications: async () => [spec],
        runTestSpecifications: async () => result,
      };
    });
    const previous = process.env.CLIENT_TEST_LANE;
    try {
      expect(await runRelated({ plan: { mode: 'related', files: [file] }, script: 'test:integration', root, create, run })).toBe(1);
      expect(create).toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      if (previous === undefined) delete process.env.CLIENT_TEST_LANE;
      else process.env.CLIENT_TEST_LANE = previous;
    }
  });
  it('drops the module graph that selection built before running the selected tests', async () => {
    const file = 'apps/client/app/constants/apiKeyScopeEndpoints.generated.test.ts';
    const spec = { moduleId: resolve(root, file), project: { name: 'node' } };
    const order = [];
    const moduleGraph = () => ({ invalidateAll: () => order.push('invalidate') });
    const create = vi.fn(async () => ({
      config: {}, close: vi.fn(), standalone: async () => {},
      projects: [
        { vite: { environments: { ssr: { moduleGraph: moduleGraph() }, client: { moduleGraph: moduleGraph() } } } },
        { vite: { environments: { ssr: { moduleGraph: moduleGraph() } } } },
      ],
      globTestSpecifications: async () => [spec],
      getRelevantTestSpecifications: async () => { order.push('select'); return [spec]; },
      runTestSpecifications: async () => { order.push('run'); return { testModules: [], unhandledErrors: [] }; },
    }));
    const previous = process.env.CLIENT_TEST_LANE;
    try {
      expect(await runRelated({ plan: { mode: 'related', files: [file] }, script: 'test:integration', root, create, run: vi.fn() })).toBe(0);
      expect(order.slice(-4)).toEqual(['invalidate', 'invalidate', 'invalidate', 'run']);
      expect(order.indexOf('invalidate')).toBeGreaterThan(order.lastIndexOf('select'));
    } finally {
      if (previous === undefined) delete process.env.CLIENT_TEST_LANE;
      else process.env.CLIENT_TEST_LANE = previous;
    }
  });
  it('runs the selected client tests from the client package directory', async () => {
    const file = 'apps/client/app/constants/apiKeyScopeEndpoints.generated.test.ts';
    const spec = { moduleId: resolve(root, file), project: { name: 'node' } };
    const before = process.cwd();
    let runCwd;
    const create = vi.fn(async () => ({
      config: {}, close: vi.fn(), standalone: async () => {},
      globTestSpecifications: async () => [spec],
      getRelevantTestSpecifications: async () => [spec],
      runTestSpecifications: async () => { runCwd = process.cwd(); return { testModules: [], unhandledErrors: [] }; },
    }));
    const previous = process.env.CLIENT_TEST_LANE;
    try {
      expect(await runRelated({ plan: { mode: 'related', files: [file] }, script: 'test:integration', root, create, run: vi.fn() })).toBe(0);
      expect(runCwd).toBe(resolve(root, 'apps/client'));
      expect(process.cwd()).toBe(before);
    } finally {
      if (previous === undefined) delete process.env.CLIENT_TEST_LANE;
      else process.env.CLIENT_TEST_LANE = previous;
    }
  });
});

describe('related CI workflow guard', () => {
  const ci = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
  it('reads ci:full from PR labels and passes diff inputs as environment data', () => {
    expect(ci).toContain("contains(github.event.pull_request.labels.*.name, 'ci:full')");
    expect(ci).toContain('run: node scripts/ci-related-tests.mjs diff');
    expect(ci).toContain('RELATED_SAFE: ${{ needs.changes.outputs.related-safe }}');
  });
  // A label-event run on the same head SHA becomes the latest CI run, and GitHub
  // reads the required Run Tests / CI Complete checks from it alone, so any label
  // run that skips or renames them leaves an approved PR blocked on "Expected".
  it('does not run on label events', () => {
    const types = ci.match(/^ {2}pull_request:\n\s+types: \[(.*)\]$/m)?.[1];
    expect(types).toBeDefined();
    const events = types.split(',').map(t => t.trim());
    expect(events).toContain('synchronize');
    expect(events).not.toContain('labeled');
    expect(events).not.toContain('unlabeled');
    expect(ci).not.toContain('github.event.label.name');
  });
  it.each([
    ['test', 'Run Tests'],
    ['ci-complete', 'CI Complete'],
  ])('reports the required %s job under its canonical name', (id, canonicalName) => {
    const block = ci.match(new RegExp(`^  ${id}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:|$(?![\\s\\S]))`, 'm'))?.[1];
    expect(block, `missing CI job ${id}`).toBeDefined();
    expect(block.match(/^ {4}name: (.+)$/m)?.[1]).toBe(canonicalName);
  });
  it('bypasses turbo only for the client in both lanes before creating any full cache context', () => {
    const blocks = ci.split('          if [ "$SELECTED_FILTER" = \'--filter @bike4mind/client\' ]');
    expect(blocks).toHaveLength(3);
    for (const block of blocks.slice(1)) {
      expect(block.indexOf('node scripts/ci-related-tests.mjs run')).toBeLessThan(block.indexOf('node scripts/turbo-test-cache.mjs context'));
      expect(block).toMatch(/node scripts\/ci-related-tests\.mjs run\n\s+exit \$\?/);
    }
    expect(ci).toContain('run: pnpm --recursive --if-present --workspace-concurrency=1 run test:repo');
    expect(ci).toContain('SHARD_ARGS: ${{ matrix.shard.args }}');
  });
});

describe('installed Vitest related API', () => {
  it('retains both projects, unions fs readers, and tiles a small selection across shards', () => {
    const script = `
      import { createVitest } from 'vitest/node';
      import { discoverRelated } from './scripts/ci-related-tests.mjs';
      import { resolve } from 'node:path';
      const root = resolve('scripts/__tests__/fixtures/ci-related');
      const seen = [];
      for (let index = 1; index <= 3; index++) {
        const vitest = await createVitest('test', {
          root, config: false, watch: false, passWithNoTests: true,
          shard: index + '/3', maxWorkers: 1, reporters: [],
          projects: [
            { resolve: { alias: { '@fixture/source': resolve(root, 'source.fixture.mjs') } }, test: { name: 'node', include: ['node.fixture.mjs', 'reader.fixture.mjs'] } },
            { test: { name: 'jsdom', include: ['dom.fixture.mjs'] } },
          ],
        });
        try {
          const specs = await discoverRelated(vitest, [resolve(root, 'source.fixture.mjs')], [resolve(root, 'test-utils/readSource.mjs')]);
          if (specs.length !== 3 || new Set(specs.map(s => s.project.name)).size !== 2) throw new Error('lost project or reader');
          await vitest.standalone();
          const result = await vitest.runTestSpecifications(specs, false);
          if (result.unhandledErrors.length || result.testModules.some(t => !t.ok())) throw new Error('fixture run failed');
          seen.push(...result.testModules.map(t => t.moduleId));
        } finally { await vitest.close(); }
      }
      if (seen.length !== 3 || new Set(seen).size !== 3) throw new Error('shards lost or duplicated tests: ' + seen);
      console.log('related fixture passed');
    `;
    expect(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root, encoding: 'utf8', timeout: 30_000, env: { ...process.env, VITEST_MAX_WORKERS: '25%' },
    })).toContain('related fixture passed');
  }, 35_000);
});
