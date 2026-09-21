import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  analyzeMockDrift,
  collectMockCalls,
  createSurfaceResolver,
  formatFinding,
  readPackageEntries,
  type PackageEntry,
} from './viMockSpecifierDrift';

/**
 * Guards #2831: a `vi.mock('<specifier>', factory)` whose stubbed symbol has moved to a different
 * subpath of the same package stops intercepting, silently. The real module loads, a test with
 * negative assertions passes vacuously, and neither `tsc` nor vitest says anything - a factory is
 * an untyped object literal, so nothing compares it against the module it replaces.
 *
 * The move of ~107 symbols out of the `@bike4mind/services` barrel produced that defect three
 * times at once, two of them green beforehand. This checks every mock factory key against the
 * export list of the built artifact the specifier actually resolves to, in both directions: a
 * barrel mock stubbing a symbol that now lives on a subpath, and a subpath mock stubbing one that
 * does not live there.
 *
 * Scoped to the open-source tree: `packages/premium/*` is a set of hydrated private overlays that
 * exist only on a developer box, so including them would pass in CI and fail locally (same reason
 * as `checkToolAvailabilityWired.test.ts`).
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const SEARCH_DIRS = 'apps b4m-core packages';
const EXCLUDES = '--exclude-dir=premium --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.next';

/**
 * Packages whose mocks must be checked. A package belongs here once it is a transitive dependency
 * of this one - so turbo's `^build` has built its `dist` before this test runs
 * (`@bike4mind/scripts#test` in turbo.json) - and every subpath in its `exports` map points at a
 * built `.mjs`, which is all `readPackageEntries` can read a surface off. A package meeting both
 * and left off this list is an invisible hole, because a missing line errors nowhere.
 *
 * That is a build-ordering rule rather than a coverage one, so it does not describe everything
 * worth checking. `@bike4mind/slack` and `@bike4mind/memory` are built, enumerable, and carry
 * mocks today, but sit outside that closure, so nothing guarantees their `dist` when this test
 * runs and their mocks go unchecked. Covering them needs an explicit build edge on
 * `@bike4mind/scripts#test` first. Listed rather than globbed so a package dropping off is a diff,
 * not a silent loss of coverage.
 */
const GUARDED_PACKAGES = [
  'b4m-core/agents',
  'b4m-core/auth',
  'b4m-core/common',
  'b4m-core/db-core',
  'b4m-core/fab-pipeline',
  'b4m-core/hearth',
  'b4m-core/llm-adapters',
  'b4m-core/mcp',
  'b4m-core/observability',
  'b4m-core/resource',
  'b4m-core/services',
  'b4m-core/utils',
  'packages/database',
];

/**
 * Mocks that may keep a key the specifier does not export. Empty on purpose: an entry here is a
 * permanent blind spot on the exact defect this guard exists to catch, so add one only with a
 * reason, keyed `<file>:<specifier>:<key>`.
 */
const ALLOWLIST = new Map<string, string>();

/**
 * A floor, not a target. The guard's real risk is passing because it compared nothing - a changed
 * mock idiom or a build that did not run would otherwise read as green. The tree has ~1200
 * analyzable calls today.
 */
const MIN_CHECKED_CALLS = 900;

function loadEntries(): Map<string, PackageEntry> {
  const entries = new Map<string, PackageEntry>();
  for (const dir of GUARDED_PACKAGES) {
    for (const [specifier, entry] of readPackageEntries(path.join(REPO_ROOT, dir))) {
      entries.set(specifier, entry);
    }
  }
  return entries;
}

function loadMockFiles(): { path: string; text: string }[] {
  const listed = execSync(
    `grep -rl "vi\\.mock(" --include="*.ts" --include="*.tsx" ${EXCLUDES} ${SEARCH_DIRS} || true`,
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  return listed
    .split('\n')
    .filter(Boolean)
    .map(rel => ({ path: rel, text: readFileSync(path.join(REPO_ROOT, rel), 'utf8') }));
}

describe('vi.mock specifiers match what the mocked module exports', () => {
  it('has no mock stubbing a symbol its specifier does not export', () => {
    const entries = loadEntries();
    const files = loadMockFiles();
    expect(files.length, `expected vi.mock call sites under ${SEARCH_DIRS}`).toBeGreaterThan(0);

    const { findings, checked, undeclared } = analyzeMockDrift(files, entries);
    const unexpected = findings.filter(f => !ALLOWLIST.has(`${f.file}:${f.specifier}:${f.key}`));

    expect(
      unexpected.map(formatFinding),
      'Point the vi.mock at the specifier that exports the symbol (the source file already imports ' +
        'it from there), or drop the key if nothing needs it. Add to ALLOWLIST only with a reason.'
    ).toEqual([]);

    expect(
      undeclared,
      "This specifier is not in that package's exports map, so it resolves to nothing and the mock " +
        'never applies. Point it at a declared subpath.'
    ).toEqual([]);

    // Asserted after the findings so a real drift reports as drift rather than as an arithmetic
    // failure on a suite that was already red.
    expect(
      checked,
      'the guard compared far fewer mocks than this tree has - has the scan or the build broken?'
    ).toBeGreaterThan(MIN_CHECKED_CALLS);
  });

  it('can enumerate the exports of every entry point it guards', () => {
    // Absence of a key is the whole signal, so an entry whose export list came back empty or
    // unenumerable would turn this guard from silent-green into noisy-red across the tree. Assert
    // the read worked rather than discovering it through a wave of false positives.
    const entries = loadEntries();
    const surfaceFor = createSurfaceResolver(entries);
    const unreadable = [...entries]
      .filter(([specifier]) => {
        const surface = surfaceFor(specifier);
        return !surface || surface.open || surface.values.size === 0;
      })
      .map(([specifier]) => specifier);

    expect(
      unreadable,
      'The export list could not be read off this built artifact - check the tsdown output shape ' +
        'against exportStatements() in viMockSpecifierDrift.ts.'
    ).toEqual([]);
  });

  it('has a built artifact behind every declared export subpath', () => {
    // The guard reads export lists off `dist`, so a declared subpath with nothing built is a hole
    // in it - and, separately, a specifier that fails to resolve for any real consumer. The
    // `exports` map and each package's `tsdown` entry list are hand-synced, which is what lets
    // them drift apart.
    const missing = [...loadEntries()]
      .filter(([, entry]) => entry.runtime && !existsSync(entry.runtime))
      .map(([specifier, entry]) => `${specifier} -> ${path.relative(REPO_ROOT, entry.runtime!)}`);

    expect(
      missing,
      "Add the entry to that package's tsdown.config.ts, or remove the subpath from its package.json exports."
    ).toEqual([]);
  });
});

describe('the drift analysis itself', () => {
  it('reads the top-level factory keys, not the keys of a nested object or method', () => {
    const [call] = collectMockCalls(
      `vi.mock('@bike4mind/services', () => ({
         importHistoryService: { ImportSource: { OPENAI: 'OpenAI' } },
         buildTools() { return { inner: 1 }; },
         ...actual,
         ['computed']: 2,
       }));`,
      'sample.test.ts'
    );
    expect(call.specifier).toBe('@bike4mind/services');
    expect(call.keys).toEqual(['importHistoryService', 'buildTools']);
  });

  it('reads the returned literal of an async factory that spreads the real module', () => {
    const [call] = collectMockCalls(
      `vi.mock('@bike4mind/services/llm', async importActual => {
         const actual = await importActual<typeof import('@bike4mind/services/llm')>();
         class Stub { run() { return { nope: 1 }; } }
         return { ...actual, buildSharedTools: vi.fn(), Orchestrator: Stub };
       });`,
      'sample.test.ts'
    );
    expect(call.keys).toEqual(['buildSharedTools', 'Orchestrator']);
  });

  it('reports a factory it cannot read statically rather than treating it as stubbing nothing', () => {
    const [call] = collectMockCalls(`vi.mock('@bike4mind/services', () => repos);`, 'sample.test.ts');
    expect(call.keys).toBeNull();
  });
});

/**
 * The deliberately reintroduced drift case. Built against fixture artifacts on disk rather than
 * the real `dist`, so it keeps asserting the failure the guard exists to produce even once the
 * repo-wide test above has gone green and stayed there.
 */
describe('a symbol that moved to a subpath', () => {
  let fixtureRoot: string;
  let entries: Map<string, PackageEntry>;

  beforeAll(() => {
    fixtureRoot = mkdtempSync(path.join(tmpdir(), 'vi-mock-drift-'));
    const write = (rel: string, body: string) => {
      const file = path.join(fixtureRoot, rel);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, body);
      return file;
    };

    // Shaped like real tsdown output: a bundle whose only line-anchored statement is the export
    // list, and - for the barrel - a star re-export of another workspace package.
    const barrel = write('dist/index.mjs', 'const userService = {};\nexport { userService };\n');
    const barrelTypes = write('dist/index.d.mts', 'type SessionRow = { id: string };\nexport { type SessionRow };\n');
    const llm = write('dist/llm/index.mjs', 'const x = 1;\nexport { resolveToolAvailability, buildSharedTools };\n');
    const crypto = write('dist/utils/crypto.mjs', 'export * from "@fixture/auth/crypto";\n');
    const authCrypto = write('auth/dist/crypto.mjs', 'export { safeCompareTokens };\n');

    const entry = (runtime: string, types: string | null = null): PackageEntry => ({
      packageName: '@fixture/services',
      runtime,
      types,
    });
    entries = new Map<string, PackageEntry>([
      ['@fixture/services', entry(barrel, barrelTypes)],
      ['@fixture/services/llm', entry(llm)],
      ['@fixture/services/utils/crypto', entry(crypto)],
      ['@fixture/auth/crypto', { packageName: '@fixture/auth', runtime: authCrypto, types: null }],
    ]);
  });

  afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  const analyze = (text: string) => analyzeMockDrift([{ path: 'drifted.test.ts', text }], entries);

  it('fails the barrel mock and names the subpath that exports the symbol', () => {
    const { findings, checked } = analyze(
      `vi.mock('@fixture/services', () => ({ userService: {}, resolveToolAvailability: vi.fn() }));`
    );
    expect(checked).toBe(1);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      specifier: '@fixture/services',
      key: 'resolveToolAvailability',
      exportedBy: ['@fixture/services/llm'],
      line: 1,
    });
    expect(formatFinding(findings[0])).toContain('exported by @fixture/services/llm');
  });

  it('fails the mirrored case - a subpath mock stubbing a symbol that subpath does not export', () => {
    const { findings } = analyze(`vi.mock('@fixture/services/llm', () => ({ userService: {} }));`);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ key: 'userService', exportedBy: ['@fixture/services'] });
  });

  it('says so plainly when the symbol is on no entry point at all', () => {
    const { findings } = analyze(`vi.mock('@fixture/services', () => ({ deletedHelper: vi.fn() }));`);
    expect(findings[0].exportedBy).toEqual([]);
    expect(formatFinding(findings[0])).toContain('the stub is dead');
  });

  it('passes a key the specifier exports only as a type, which has no runtime binding to drift', () => {
    expect(analyze(`vi.mock('@fixture/services', () => ({ SessionRow: {} }));`).findings).toEqual([]);
  });

  it('follows an `export * from` re-export chain before deciding a key is missing', () => {
    const { findings } = analyze(`vi.mock('@fixture/services/utils/crypto', () => ({ safeCompareTokens: vi.fn() }));`);
    expect(findings).toEqual([]);
  });

  it('stays silent on a factory whose keys it cannot read, rather than guessing', () => {
    const { findings, unanalyzable } = analyze(`vi.mock('@fixture/services', () => buildStubs());`);
    expect(findings).toEqual([]);
    expect(unanalyzable).toEqual(['drifted.test.ts:1 @fixture/services']);
  });

  it('fails a mock on a subpath the package owns but no longer declares', () => {
    const { undeclared } = analyze(`vi.mock('@fixture/services/renamed', () => ({ userService: {} }));`);
    expect(undeclared).toEqual(['drifted.test.ts:1 @fixture/services/renamed']);
  });

  it('ignores a specifier no guarded package owns', () => {
    const { undeclared, findings } = analyze(`vi.mock('@server/utils/sqs', () => ({ sendToQueue: vi.fn() }));`);
    expect([...undeclared, ...findings]).toEqual([]);
  });
});
