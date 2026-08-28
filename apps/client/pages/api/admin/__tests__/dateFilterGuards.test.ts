import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * These routes take a caller-supplied date string straight into a Date-typed Mongoose
 * filter. An unparseable value becomes an Invalid Date and throws a CastError at the query,
 * which errorHandler reports as a 500 because the cast is not on `_id`. Each route must
 * reject it as a client error before anything reaches the database.
 */

const mocks = vi.hoisted(() => ({
  snapshotFind: vi.fn(),
  slackFindByDateRange: vi.fn(),
  listJobs: vi.fn(),
  findJobById: vi.fn(),
  findAttemptsByJob: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.GET = fns[fns.length - 1]), chain),
        post: () => chain,
      }
    );
    return chain;
  },
}));

vi.mock('@bike4mind/database', () => ({
  RateLimitSnapshot: {
    find: (...a: unknown[]) => mocks.snapshotFind(...a),
  },
  slackAuditLogRepository: {
    findByDateRange: (...a: unknown[]) => mocks.slackFindByDateRange(...a),
  },
  emailJobRepository: {
    listJobs: (...a: unknown[]) => mocks.listJobs(...a),
    findById: (...a: unknown[]) => mocks.findJobById(...a),
  },
  emailSendAttemptRepository: {
    findByJob: (...a: unknown[]) => mocks.findAttemptsByJob(...a),
  },
  emailTemplateRepository: {},
  SlackAuditEventType: {},
}));

vi.mock('@bike4mind/observability', () => ({ Logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import rateLimitsHandler from '../rate-limits';
import slackAuditLogsHandler from '../slack-audit-logs';
import emailJobsHandler from '../email/jobs';
import emailJobAnalyticsHandler from '../email/jobs/[id]/analytics';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const run = (handler: unknown, query: Record<string, string>) => {
  const { req, res } = createMocks({ method: 'GET', query });
  (req as Record<string, unknown>).user = { id: 'admin1', isAdmin: true };
  return { res, promise: (handler as Handler)(req, res) };
};

beforeEach(() => {
  mocks.snapshotFind.mockReset().mockReturnValue({
    sort: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }),
  });
  mocks.slackFindByDateRange.mockReset().mockResolvedValue([]);
  mocks.listJobs.mockReset().mockResolvedValue({ jobs: [], total: 0 });
  mocks.findJobById.mockReset().mockResolvedValue({
    id: 'job1',
    name: 'j',
    status: 'sent',
    recipientCount: 0,
    sentCount: 0,
    openedCount: 0,
    clickedCount: 0,
    failedCount: 0,
  });
  mocks.findAttemptsByJob.mockReset().mockResolvedValue({ attempts: [], total: 0 });
});

const cases: Array<{ name: string; handler: unknown; params: string[]; queried: () => unknown }> = [
  { name: 'rate-limits', handler: rateLimitsHandler, params: ['dateFrom', 'dateTo'], queried: () => mocks.snapshotFind },
  {
    name: 'slack-audit-logs',
    handler: slackAuditLogsHandler,
    params: ['startDate', 'endDate'],
    queried: () => mocks.slackFindByDateRange,
  },
  {
    name: 'email/jobs',
    handler: emailJobsHandler,
    params: ['startDate', 'endDate'],
    queried: () => mocks.listJobs,
  },
  {
    name: 'email/jobs/[id]/analytics',
    handler: emailJobAnalyticsHandler,
    params: ['startDate', 'endDate'],
    queried: () => mocks.findAttemptsByJob,
  },
];

describe.each(cases)('$name - date filter guard', ({ handler, params, queried }) => {
  it.each(params)('rejects an unparseable %s before any query runs', async param => {
    const { promise } = run(handler, { id: 'job1', [param]: 'not-a-date' });
    await expect(promise).rejects.toThrow(/date/i);
    expect(queried()).not.toHaveBeenCalled();
  });

  it('still runs the query for a parseable date', async () => {
    const [first] = params;
    const { promise } = run(handler, { id: 'job1', [first]: '2026-08-01T00:00:00.000Z' });
    await promise;
    expect(queried()).toHaveBeenCalled();
  });
});
