import { describe, expect, it, vi } from 'vitest';
import type { IDataLakeDocument } from '@bike4mind/common';
import { recordResearchRunOutcome, type ResearchRunOutcomeAdapters } from './recordResearchRunOutcome';

const lake = (overrides: Partial<IDataLakeDocument> = {}) =>
  ({ id: 'lake-1', createdByUserId: 'owner-1', ...overrides }) as IDataLakeDocument;

const makeAdapters = () => {
  const record = vi.fn(async () => undefined);
  const adapters = { db: { lakeConfigChangeEvents: { record } } } as unknown as ResearchRunOutcomeAdapters;
  return { adapters, record };
};

describe('recordResearchRunOutcome', () => {
  // A run reaching an outcome left no trace in the lake's History tab.
  it('records a completed outcome under the system rung, naming the run query and id', async () => {
    const { adapters, record } = makeAdapters();

    await recordResearchRunOutcome(lake(), 'coastal erosion', 'completed', 'run-1', adapters);

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        principalKind: 'system',
        principalId: 'system',
        dataLakeId: 'lake-1',
        manageRung: 'system',
        action: 'complete-research-run',
        changes: [{ field: 'researchRun', kind: 'literal', after: 'completed: coastal erosion (run run-1)' }],
      })
    );
  });

  it('records a failed outcome the same way', async () => {
    const { adapters, record } = makeAdapters();

    await recordResearchRunOutcome(lake(), 'coastal erosion', 'failed', 'run-1', adapters);

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'complete-research-run',
        changes: [{ field: 'researchRun', kind: 'literal', after: 'failed: coastal erosion (run run-1)' }],
      })
    );
  });

  // Two runs of the same unedited config share a query - the run id is what tells their History
  // rows apart, and what pairs a `started` row with the right `completed`/`failed` row.
  it('encodes the run id, so two runs of the same query do not read as one', async () => {
    const { adapters, record } = makeAdapters();

    await recordResearchRunOutcome(lake(), 'coastal erosion', 'completed', 'run-2', adapters);

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: [{ field: 'researchRun', kind: 'literal', after: 'completed: coastal erosion (run run-2)' }],
      })
    );
  });

  // Never a human actor: this runs from the background executor, which has no session behind it -
  // a scheduled v2 run has none at all.
  it('never attributes the write to the lake creator, even though nothing else authorized it', async () => {
    const { adapters, record } = makeAdapters();

    await recordResearchRunOutcome(lake({ createdByUserId: 'owner-1' }), 'q', 'completed', 'run-1', adapters);

    expect(record.mock.calls[0][0]).not.toMatchObject({ principalKind: 'user', principalId: 'owner-1' });
  });

  it('is best-effort: a failed write does not throw', async () => {
    const { adapters, record } = makeAdapters();
    record.mockRejectedValue(new Error('replica set stepped down'));

    await expect(recordResearchRunOutcome(lake(), 'q', 'completed', 'run-1', adapters)).resolves.toBeUndefined();
  });
});
