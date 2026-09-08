import { describe, it, expect, vi, beforeEach } from 'vitest';

type Filter = Record<string, unknown>;

const mockDistinctSurvivingPrincipalIds = vi.fn<() => Promise<string[]>>();
const mockUpdateMany = vi.fn<(filter: Filter, update: Filter) => Promise<{ modifiedCount: number }>>();

vi.mock('@bike4mind/database', () => ({
  DataLakeModel: { updateMany: (filter: Filter, update: Filter) => mockUpdateMany(filter, update) },
  memoryLedgerRepository: { distinctSurvivingPrincipalIds: () => mockDistinctSurvivingPrincipalIds() },
}));

import migration from './20260906000000_backfill-lakememoryenabled-from-ledger';

let logged: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  });
  mockUpdateMany.mockResolvedValue({ modifiedCount: 0 });
  mockDistinctSurvivingPrincipalIds.mockResolvedValue([]);
});

const output = () => logged.join('\n');

describe('backfill-lakememoryenabled-from-ledger', () => {
  describe('up', () => {
    it('enables lakeMemoryEnabled only for lakes whose datalakeTag has a surviving ledger chain', async () => {
      mockDistinctSurvivingPrincipalIds.mockResolvedValue(['datalake:acme', 'datalake:other']);
      mockUpdateMany.mockResolvedValue({ modifiedCount: 2 });

      await migration.up();

      expect(mockUpdateMany).toHaveBeenCalledWith(
        { datalakeTag: { $in: ['datalake:acme', 'datalake:other'] }, lakeMemoryEnabled: { $ne: true } },
        { $set: { lakeMemoryEnabled: true } }
      );
      expect(output()).toContain('2 lake(s) with a surviving profile; 2 enabled');
    });

    it('is a no-op when the ledger has no surviving lake chains at all', async () => {
      mockDistinctSurvivingPrincipalIds.mockResolvedValue([]);

      await migration.up();

      expect(mockUpdateMany).not.toHaveBeenCalled();
      expect(output()).toContain('no surviving lake ledger chains found, nothing to do');
    });

    it('targets exactly the tags the ledger reported, adding none of its own', async () => {
      // What this file CAN check: the migration's population is whatever
      // `distinctSurvivingPrincipalIds` returned, unwidened. It cannot check that a purged lake is
      // absent from that list, because the repository is mocked here - the `shredded: { $ne: true }`
      // guard that decides it lives in MemoryLedgerEventModel and is covered against a real Mongo in
      // its own tests. A version of this test that mocked a purged tag out of the return value and
      // then asserted its absence would have been asserting the mock.
      mockDistinctSurvivingPrincipalIds.mockResolvedValue(['datalake:has-facts', 'datalake:also']);
      mockUpdateMany.mockResolvedValue({ modifiedCount: 2 });

      await migration.up();

      const [filter] = mockUpdateMany.mock.calls[0];
      expect(filter.datalakeTag).toEqual({ $in: ['datalake:has-facts', 'datalake:also'] });
      expect(Object.keys(filter).sort()).toEqual(['datalakeTag', 'lakeMemoryEnabled']);
    });

    it('carries the already-enabled guard on every run, so a re-run flips nothing', async () => {
      // The guard IS the idempotency: `lakeMemoryEnabled: { $ne: true }` is what makes the second
      // run's write a no-op. Asserted on both calls, because a call count and a `modifiedCount: 0`
      // the mock was told to return prove nothing about the filter that produced it.
      mockDistinctSurvivingPrincipalIds.mockResolvedValue(['datalake:acme']);
      mockUpdateMany.mockResolvedValueOnce({ modifiedCount: 1 });
      await migration.up();

      mockUpdateMany.mockResolvedValueOnce({ modifiedCount: 0 });
      await migration.up();

      expect(mockUpdateMany).toHaveBeenCalledTimes(2);
      for (const [filter, update] of mockUpdateMany.mock.calls) {
        expect(filter.lakeMemoryEnabled).toEqual({ $ne: true });
        expect(update).toEqual({ $set: { lakeMemoryEnabled: true } });
      }
      expect(output()).toContain('1 lake(s) with a surviving profile; 0 enabled');
    });
  });

  describe('down', () => {
    it('reverses lakeMemoryEnabled only for the lakes it would currently find', async () => {
      mockDistinctSurvivingPrincipalIds.mockResolvedValue(['datalake:acme']);
      mockUpdateMany.mockResolvedValue({ modifiedCount: 1 });

      await migration.down();

      expect(mockUpdateMany).toHaveBeenCalledWith(
        { datalakeTag: { $in: ['datalake:acme'] } },
        { $set: { lakeMemoryEnabled: false } }
      );
      expect(output()).toContain('down: disabled lakeMemoryEnabled for 1 lake(s)');
    });

    it('is a no-op when there are no surviving lake chains', async () => {
      mockDistinctSurvivingPrincipalIds.mockResolvedValue([]);

      await migration.down();

      expect(mockUpdateMany).not.toHaveBeenCalled();
    });
  });
});
