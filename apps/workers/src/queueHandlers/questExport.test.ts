import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The quest export queue carries one live job, the organization feedback summary. The v4 plan
 * export that used to share it is retired: its `questmasterplans` collection is dropped, so a
 * message of that shape must be acknowledged and discarded without reading a plan or chat history.
 * This drives the REAL `dispatch`. The worker imports no database model; the three models the old
 * export read are replaced with a proxy that throws, so re-adding one of those reads fails here.
 */
const h = vi.hoisted(() => ({
  runOrgFeedbackSummary: vi.fn<
    (message: unknown, logger: unknown, checkBudget: (minimumRemainingMs?: number) => void) => Promise<void>
  >(async () => undefined),
  databaseAccess: vi.fn(),
}));

// Run the raw handler directly (no SQS logger injection wrapper).
vi.mock('@bike4mind/server-utils/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...args: unknown[]) => unknown) => fn,
}));

vi.mock('@bike4mind/database', () => {
  const model = new Proxy(
    {},
    {
      get(_, method) {
        return (...args: unknown[]) => {
          h.databaseAccess(String(method), ...args);
          throw new Error(`questExport must not read the database (${String(method)})`);
        };
      },
    }
  );
  return { QuestMasterPlan: model, Quest: model, FabFile: model };
});

// The real parse, not an identity stub: this queue carries two message shapes and the union that
// tells them apart is what these tests drive.
vi.mock('@bike4mind/utils', () => ({
  secureParameters: (obj: unknown, schema: { parse: (value: unknown) => unknown }) => schema.parse(obj),
}));

vi.mock('@bike4mind/common', () => ({ ORG_FEEDBACK_SUMMARY_JOB_TYPE: 'orgFeedbackSummary' }));

// The summary worker is exercised in its own file; here only the routing matters. The payload
// schema is real because the dispatch's union is built from it at module load.
vi.mock('@workers/queueHandlers/orgFeedbackSummary', async () => {
  const { z } = await import('zod');
  return {
    OrgFeedbackSummaryPayload: z.object({
      jobType: z.literal('orgFeedbackSummary'),
      summaryJobId: z.string(),
      organizationId: z.string(),
      startDate: z.string(),
      endDate: z.string(),
      userId: z.string(),
    }),
    runOrgFeedbackSummary: h.runOrgFeedbackSummary,
  };
});

import { dispatch } from './questExport';

const makeLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), updateMetadata: vi.fn() });
const run = (payload: unknown, remainingMs = 600000, logger = makeLogger()) =>
  dispatch(
    { Records: [{ body: JSON.stringify(payload) }] } as never,
    { getRemainingTimeInMillis: () => remainingMs } as never,
    logger as never
  );

beforeEach(() => vi.clearAllMocks());

describe('questExport queue routing', () => {
  it('routes a tagged summary message to the summary worker', async () => {
    const event = {
      Records: [
        {
          body: JSON.stringify({
            jobType: 'orgFeedbackSummary',
            summaryJobId: 'sum-1',
            organizationId: 'org-1',
            startDate: '2026-08-01T00:00:00.000Z',
            endDate: '2026-08-31T00:00:00.000Z',
            userId: 'requester-1',
          }),
        },
      ],
    };

    const remaining = vi.fn(() => 120000);
    const logger = makeLogger();
    await dispatch(event as never, { getRemainingTimeInMillis: remaining } as never, logger as never);

    expect(h.runOrgFeedbackSummary).toHaveBeenCalledWith(
      expect.objectContaining({ summaryJobId: 'sum-1' }),
      expect.anything(),
      expect.any(Function)
    );
    expect(h.databaseAccess).not.toHaveBeenCalled();
    // A summary is never also reported as a discarded plan export.
    expect(logger.warn).not.toHaveBeenCalled();

    const checkBudget = h.runOrgFeedbackSummary.mock.calls[0][2];
    expect(() => checkBudget(120000)).not.toThrow();
    remaining.mockReturnValue(119999);
    expect(() => checkBudget(120000)).toThrow('Quest export run budget exhausted');
    remaining.mockReturnValue(1000);
    expect(() => checkBudget()).not.toThrow();
    remaining.mockReturnValue(999);
    expect(() => checkBudget()).toThrow('Quest export run budget exhausted');
  });
});

describe('retired v4 plan export messages', () => {
  const planExport = { exportJobId: 'job-1', planId: 'plan-1', userId: 'owner-1' };

  it.each([
    ['untagged', planExport],
    ['tagged questExport', { ...planExport, jobType: 'questExport' }],
  ])('acknowledges and discards an %s message without reading a plan', async (_label, payload) => {
    const logger = makeLogger();

    await expect(run(payload, 600000, logger)).resolves.toBeUndefined();

    expect(h.databaseAccess).not.toHaveBeenCalled();
    expect(h.runOrgFeedbackSummary).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith('[questExport] Discarded a retired v4 plan export message', {
      exportJobId: 'job-1',
      planId: 'plan-1',
      userId: 'owner-1',
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('discards it even with no run budget left, so it is never retried into the DLQ', async () => {
    await expect(run(planExport, 0)).resolves.toBeUndefined();
  });

  it('still rejects a message that is neither a summary nor a retired plan export', async () => {
    await expect(run({ jobType: 'orgFeedbackSummary', summaryJobId: 'sum-1' })).rejects.toThrow();
    await expect(run({ planId: 'plan-1' })).rejects.toThrow();
    await expect(run({ ...planExport, jobType: 'somethingElse' })).rejects.toThrow();
    expect(h.runOrgFeedbackSummary).not.toHaveBeenCalled();
  });
});
