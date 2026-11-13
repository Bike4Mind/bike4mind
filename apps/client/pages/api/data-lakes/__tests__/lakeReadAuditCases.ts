import { describe, it, expect, beforeEach, type Mock } from 'vitest';

interface LakeReadAuditCases {
  surface: string;
  lakeId: string;
  /** The mocked `lakeAccessEventRepository.record`. */
  record: Mock;
  /** The mocked `adminBypassLakeIds` from `@server/dataLakes`. */
  bypass: Mock;
  /** Runs the handler against a lake with content to return; resolves true once it responded. */
  run: () => Promise<boolean>;
  /** Runs the handler against a lake with nothing to return. */
  runEmpty?: () => Promise<boolean>;
}

/** The access-audit contract every lake read door shares. */
export const describeLakeReadAudit = ({ surface, lakeId, record, bypass, run, runEmpty }: LakeReadAuditCases) =>
  describe('lake access audit', () => {
    beforeEach(() => {
      record.mockReset().mockResolvedValue(undefined);
      bypass.mockReset().mockResolvedValue([]);
    });

    it('records the read once with its surface', async () => {
      await run();
      expect(record).toHaveBeenCalledTimes(1);
      expect(record.mock.calls[0][0]).toMatchObject({ resolvedLakeIds: [lakeId], surface });
    });

    it('marks an admin-bypass read', async () => {
      bypass.mockResolvedValue([lakeId]);
      await run();
      expect(bypass).toHaveBeenCalledWith(expect.anything(), [lakeId]);
      expect(record.mock.calls[0][0]).toMatchObject({ surface, adminBypassLakeIds: [lakeId] });
    });

    it('fails the request when a bypass audit write rejects', async () => {
      bypass.mockResolvedValue([lakeId]);
      record.mockRejectedValueOnce(new Error('mongo blip'));
      await expect(run()).rejects.toThrow('mongo blip');
    });

    it('fails the request when the bypass lookup rejects', async () => {
      bypass.mockRejectedValue(new Error('lookup down'));
      await expect(run()).rejects.toThrow('lookup down');
      expect(record).not.toHaveBeenCalled();
    });

    it('records a member read unmarked and still responds when that write rejects', async () => {
      await run();
      expect(record.mock.calls[0][0]).not.toHaveProperty('adminBypassLakeIds');

      record.mockRejectedValueOnce(new Error('mongo blip'));
      await expect(run()).resolves.toBe(true);
    });

    if (runEmpty) {
      it('records nothing when there is nothing to return', async () => {
        await runEmpty();
        expect(record).not.toHaveBeenCalled();
      });
    }
  });
