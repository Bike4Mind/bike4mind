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

    it('does not re-enable a lake whose profile was purged (all ledger events shredded)', async () => {
      // distinctSurvivingPrincipalIds itself excludes fully-shredded chains (shredded: {$ne: true}),
      // so a purged lake's tag never reaches the $in list, and updateMany cannot touch it.
      mockDistinctSurvivingPrincipalIds.mockResolvedValue(['datalake:has-facts']);
      mockUpdateMany.mockResolvedValue({ modifiedCount: 1 });

      await migration.up();

      const [filter] = mockUpdateMany.mock.calls[0];
      expect((filter.datalakeTag as { $in: string[] }).$in).toEqual(['datalake:has-facts']);
      expect((filter.datalakeTag as { $in: string[] }).$in).not.toContain('datalake:purged');
    });

    it('running up twice is idempotent: the second run finds nothing left to flip', async () => {
      mockDistinctSurvivingPrincipalIds.mockResolvedValue(['datalake:acme']);
      mockUpdateMany.mockResolvedValueOnce({ modifiedCount: 1 });
      await migration.up();

      mockUpdateMany.mockResolvedValueOnce({ modifiedCount: 0 });
      await migration.up();

      expect(mockUpdateMany).toHaveBeenCalledTimes(2);
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
