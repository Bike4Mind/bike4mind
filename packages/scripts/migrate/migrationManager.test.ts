import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from '@bike4mind/observability';

// Mirrors the mocking convention in migrations/*.test.ts: mock @bike4mind/database's
// Migration model at the collection level rather than spinning up a real Mongo server -
// the selection logic under test is pure filtering over (AvailableMigrations, applied ids).

interface FakeMigrationDoc {
  id: number;
  name: string;
}

let migrationDocs: FakeMigrationDoc[] = [];

const FakeMigration = {
  find: vi.fn(async () => [...migrationDocs]),
  create: vi.fn(async (doc: FakeMigrationDoc) => {
    migrationDocs.push(doc);
    return doc;
  }),
  deleteOne: vi.fn(async (filter: { id: number }) => {
    const before = migrationDocs.length;
    migrationDocs = migrationDocs.filter(d => d.id !== filter.id);
    return { deletedCount: before - migrationDocs.length };
  }),
};

vi.mock('@bike4mind/database', () => ({
  Migration: FakeMigration,
  connectDB: vi.fn(),
  getDB: vi.fn(),
}));

interface FakeMigrationFile {
  id: number;
  name: string;
  up: () => Promise<void>;
  down: () => Promise<void>;
}

let fakeAvailableMigrations: FakeMigrationFile[] = [];

vi.mock('./migrations', () => ({
  get AvailableMigrations() {
    return fakeAvailableMigrations;
  },
}));

vi.mock('../seeders', () => ({ seeders: [] }));

// migrationManager.ts imports Config from here; Config.ts evaluates SST Resource bindings
// (Resource.MONGODB_URI.value, etc.) at module load time, which throws outside an SST-linked
// process. up()/down() never touch Config - only seed()/cleanup() do - so an empty stub is fine.
vi.mock('../utils/config', () => ({ Config: {} }));

// Imported after the mocks above so migrationManager.ts's top-level `import {
// AvailableMigrations } from './migrations'` resolves to the mock.
const { MigrationManager, selectPending } = await import('./migrationManager');

function migration(id: number): FakeMigrationFile {
  return { id, name: `migration-${id}`, up: vi.fn(async () => undefined), down: vi.fn(async () => undefined) };
}

describe('selectPending - shared applied-set selection', () => {
  // Regression test for a real bug caught in review of the PR that introduced applied-set
  // selection: migrate/index.ts's `list --pending` kept its own inline high-water-mark filter
  // after up()/down() moved to this shared helper, so `list` reported nothing pending while
  // `up` silently ran an overlay migration - the exact gap case this whole change exists to fix.
  // Both up() and list() now call selectPending() directly, so they cannot drift again.
  it('matches the gap case: an id below the max applied id is still pending', () => {
    const m1 = migration(1);
    const m2 = migration(2);
    const m3 = migration(3);
    const appliedIds = new Set([1, 3]); // 2 was never applied, despite 3 > 2 being applied

    const pending = selectPending([m1, m2, m3], appliedIds);

    expect(pending).toEqual([m2]);
  });

  it('returns nothing when every migration is already applied', () => {
    const m1 = migration(1);
    const m2 = migration(2);

    expect(selectPending([m1, m2], new Set([1, 2]))).toEqual([]);
  });

  it('respects an explicit target ceiling', () => {
    const m1 = migration(1);
    const m2 = migration(2);
    const m3 = migration(3);

    expect(selectPending([m1, m2, m3], new Set([1]), 2)).toEqual([m2]);
  });

  it('sorts pending migrations ascending by id regardless of input order', () => {
    const m1 = migration(1);
    const m2 = migration(2);
    const m3 = migration(3);

    expect(selectPending([m3, m1, m2], new Set())).toEqual([m1, m2, m3]);
  });
});

describe('MigrationManager - applied-set selection (M0)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    migrationDocs = [];
    fakeAvailableMigrations = [];
  });

  it('up() runs a migration whose id is BELOW the max applied id (the gap case)', async () => {
    // Simulates: core migration 1 applied, then core migration 3 applied on a later
    // deploy, but migration 2 (e.g. an overlay migration authored earlier but pin-bumped
    // in later) has never run. A high-water-mark filter (`id > max applied`) would skip
    // it forever since 2 < 3. Applied-set selection must still pick it up.
    const m1 = migration(1);
    const m2 = migration(2);
    const m3 = migration(3);
    fakeAvailableMigrations = [m1, m2, m3];
    migrationDocs = [
      { id: 1, name: m1.name },
      { id: 3, name: m3.name },
    ];

    const manager = new MigrationManager(new Logger());
    await manager.up(null);

    expect(m1.up).not.toHaveBeenCalled();
    expect(m2.up).toHaveBeenCalledOnce();
    expect(m3.up).not.toHaveBeenCalled();
    expect(migrationDocs.map(d => d.id).sort()).toEqual([1, 2, 3]);
  });

  it('up() runs nothing when every migration is already applied, regardless of id order', async () => {
    const m1 = migration(1);
    const m2 = migration(2);
    fakeAvailableMigrations = [m1, m2];
    migrationDocs = [
      { id: 2, name: m2.name },
      { id: 1, name: m1.name },
    ];

    const manager = new MigrationManager(new Logger());
    await manager.up(null);

    expect(m1.up).not.toHaveBeenCalled();
    expect(m2.up).not.toHaveBeenCalled();
  });

  it('up() respects an explicit target ceiling even with a gap below it', async () => {
    const m1 = migration(1);
    const m2 = migration(2);
    const m3 = migration(3);
    fakeAvailableMigrations = [m1, m2, m3];
    migrationDocs = [{ id: 1, name: m1.name }];

    const manager = new MigrationManager(new Logger());
    await manager.up(2);

    expect(m2.up).toHaveBeenCalledOnce();
    expect(m3.up).not.toHaveBeenCalled();
  });

  it('down() reverts only migrations present in the applied set, in descending id order', async () => {
    const m1 = migration(1);
    const m2 = migration(2);
    const m3 = migration(3);
    fakeAvailableMigrations = [m1, m2, m3];
    migrationDocs = [
      { id: 1, name: m1.name },
      { id: 3, name: m3.name },
    ]; // migration 2 was never applied - down() must not touch it

    const manager = new MigrationManager(new Logger());
    await manager.down(null);

    expect(m3.down).toHaveBeenCalledOnce();
    expect(m1.down).toHaveBeenCalledOnce();
    expect(m2.down).not.toHaveBeenCalled();
    expect(migrationDocs).toHaveLength(0);
  });

  it('down() with a target only reverts applied migrations above the target', async () => {
    const m1 = migration(1);
    const m2 = migration(2);
    const m3 = migration(3);
    fakeAvailableMigrations = [m1, m2, m3];
    migrationDocs = [
      { id: 1, name: m1.name },
      { id: 2, name: m2.name },
      { id: 3, name: m3.name },
    ];

    const manager = new MigrationManager(new Logger());
    await manager.down(1);

    expect(m3.down).toHaveBeenCalledOnce();
    expect(m2.down).toHaveBeenCalledOnce();
    expect(m1.down).not.toHaveBeenCalled();
    expect(migrationDocs.map(d => d.id)).toEqual([1]);
  });
});
