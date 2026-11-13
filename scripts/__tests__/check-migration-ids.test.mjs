import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  MIGRATIONS_DIR,
  checkMigrationIds,
  findProblems,
  formatId,
  migrationFilesIn,
  parseMigrationId,
} from '../check-migration-ids.mjs';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 12, 9, 30, 15);

describe('parseMigrationId', () => {
  it('accepts a real UTC timestamp', () => {
    expect(parseMigrationId('20261112093015')).toBe(NOW);
  });

  it.each([
    ['hour 24', '20260921241030'],
    ['minute 60', '20260921236000'],
    ['second 99', '20260921249990'],
    ['month 13', '20261312000000'],
    ['Feb 30', '20260230000000'],
    ['13 digits', '2024052201905'],
    ['15 digits', '202609210000001'],
  ])('rejects %s', (_label, id) => {
    expect(parseMigrationId(id)).toBeNull();
  });
});

describe('migrationFilesIn', () => {
  it('keeps migration files and skips tests, the registry and helpers', () => {
    const files = migrationFilesIn([
      '20261112093015_add-field.ts',
      '20261112093015_add-field.test.ts',
      '2024052201905_demo_to_paid.ts',
      'index.ts',
      'core.generated.ts',
      'legacySignupGrantSchedule.ts',
    ]);
    expect(files.map(f => f.id)).toEqual(['20261112093015', '2024052201905']);
  });
});

describe('findProblems', () => {
  const added = (id, floorMs = NOW) => [{ id, filename: `${id}_x.ts`, floorMs }];

  it('passes a freshly generated id', () => {
    expect(findProblems(added(formatId(NOW - 5 * 60 * 1000)), NOW)).toEqual([]);
  });

  it('rejects an id that is not a timestamp', () => {
    expect(findProblems(added('20260921241030'), NOW)).toEqual([expect.stringContaining('not a valid UTC timestamp')]);
  });

  it('allows small clock skew but rejects a future id', () => {
    expect(findProblems(added(formatId(NOW + HOUR - 1000)), NOW)).toEqual([]);
    expect(findProblems(added(formatId(NOW + HOUR + 1000)), NOW)).toEqual([expect.stringContaining('in the future')]);
  });

  it('allows the grace period below the floor but rejects anything older', () => {
    expect(findProblems(added(formatId(NOW - DAY + 1000)), NOW)).toEqual([]);
    expect(findProblems(added(formatId(NOW - DAY - 1000)), NOW)).toEqual([
      expect.stringContaining('older than this change'),
    ]);
  });
});

describe('checkMigrationIds (real git repo)', () => {
  let repo;
  const migrationsPath = () => join(repo, MIGRATIONS_DIR);

  // Dates are pinned so the floor is deterministic: the base commit is the fork point.
  function commit(message, isoDate) {
    const env = { ...process.env, GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate };
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', message], {
      cwd: repo,
      env,
    });
  }

  function addMigration(id) {
    writeFileSync(join(migrationsPath(), `${id}_thing.ts`), `export default { id: ${id} };\n`);
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'migration-ids-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    mkdirSync(migrationsPath(), { recursive: true });
    // Grandfathered: malformed and hand-picked ids already on the base are never re-checked.
    writeFileSync(join(migrationsPath(), '2024052201905_demo_to_paid.ts'), 'export default {};\n');
    writeFileSync(join(migrationsPath(), '20260921241030_old.ts'), 'export default {};\n');
    writeFileSync(join(migrationsPath(), 'index.ts'), 'export {};\n');
    commit('base', '2026-11-12T08:00:00Z');
    execFileSync('git', ['checkout', '-qb', 'feature'], { cwd: repo });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('fails on an added hand-picked id and names the generator', () => {
    addMigration('20260921241031');
    commit('add migration', '2026-11-12T09:00:00Z');
    const problems = checkMigrationIds({ cwd: repo, base: 'main', nowMs: NOW });
    expect(problems).toEqual([expect.stringContaining('20260921241031_thing.ts')]);
    const out = runCli();
    expect(out.status).toBe(1);
    expect(out.stderr).toContain('pnpm migrate generate');
  });

  it('fails on an added file that reuses an id already on the base', () => {
    addMigration('20260921241030');
    commit('add migration', '2026-11-12T09:00:00Z');
    expect(checkMigrationIds({ cwd: repo, base: 'main', nowMs: NOW })).toEqual([
      '20260921241030_thing.ts: id 20260921241030 is already used by 20260921241030_old.ts.',
    ]);
  });

  it('fails when two added files share an id', () => {
    const id = formatId(NOW - 60 * 1000);
    addMigration(id);
    writeFileSync(join(migrationsPath(), `${id}_twin.ts`), `export default { id: ${id} };\n`);
    commit('add migrations', '2026-11-12T09:00:00Z');
    expect(checkMigrationIds({ cwd: repo, base: 'main', nowMs: NOW })).toHaveLength(2);
  });

  it('fails on an added valid id that predates the change', () => {
    addMigration('20260921000003');
    commit('add migration', '2026-11-12T09:00:00Z');
    expect(checkMigrationIds({ cwd: repo, base: 'main', nowMs: NOW })).toEqual([
      expect.stringContaining('older than this change'),
    ]);
  });

  it('passes an added generated id', () => {
    addMigration(formatId(NOW - 20 * 60 * 1000));
    commit('add migration', '2026-11-12T09:15:00Z');
    expect(checkMigrationIds({ cwd: repo, base: 'main', nowMs: NOW })).toEqual([]);
  });

  it('ignores grandfathered files, including a slug rename that keeps the id', () => {
    renameSync(join(migrationsPath(), '20260921241030_old.ts'), join(migrationsPath(), '20260921241030_renamed.ts'));
    commit('rename slug', '2026-11-12T09:00:00Z');
    expect(checkMigrationIds({ cwd: repo, base: 'main', nowMs: NOW })).toEqual([]);
  });

  it('checks the new id when an existing file is renamed to a different id', () => {
    renameSync(join(migrationsPath(), '20260921241030_old.ts'), join(migrationsPath(), '20260921249990_old.ts'));
    commit('re-id', '2026-11-12T09:00:00Z');
    expect(checkMigrationIds({ cwd: repo, base: 'main', nowMs: NOW })).toEqual([
      expect.stringContaining('20260921249990_old.ts'),
    ]);
  });

  it('checks an added id that main gained after the fork point, rather than reading it as a rename', () => {
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repo });
    writeFileSync(join(migrationsPath(), '20260921241031_landed.ts'), 'export default {};\n');
    commit('other PR lands', '2026-11-12T08:30:00Z');
    execFileSync('git', ['checkout', '-q', 'feature'], { cwd: repo });
    addMigration('20260921241031');
    commit('add migration', '2026-11-12T09:00:00Z');
    expect(checkMigrationIds({ cwd: repo, base: 'main', nowMs: NOW })).toEqual([
      expect.stringContaining('not a valid UTC timestamp'),
    ]);
  });

  it('keeps an id fresh when it was generated before a rebase onto a newer base', () => {
    const generatedAt = Date.UTC(2026, 10, 1, 10, 0, 0);
    addMigration(formatId(generatedAt));
    commit('add migration', new Date(generatedAt + 60 * 1000).toISOString());
    // Simulate the rebase: the author date stays, the fork point moves to a much newer base.
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repo });
    writeFileSync(join(repo, 'unrelated.txt'), 'x\n');
    commit('newer main', '2026-11-12T08:30:00Z');
    execFileSync('git', ['checkout', '-q', 'feature'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'rebase', '-q', 'main'], {
      cwd: repo,
      env: { ...process.env, GIT_COMMITTER_DATE: '2026-11-12T09:00:00Z' },
    });
    expect(checkMigrationIds({ cwd: repo, base: 'main', nowMs: NOW })).toEqual([]);
  });

  function runCli() {
    try {
      const stdout = execFileSync(
        'node',
        [join(import.meta.dirname, '..', 'check-migration-ids.mjs'), '--base', 'main'],
        {
          cwd: repo,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      return { status: 0, stdout, stderr: '' };
    } catch (error) {
      return { status: error.status, stdout: error.stdout, stderr: error.stderr };
    }
  }
});
