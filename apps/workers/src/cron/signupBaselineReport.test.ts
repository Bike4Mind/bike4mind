import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  resource: { App: { stage: 'production' } },
  connect: vi.fn(),
  report: vi.fn(),
}));
vi.mock('sst', () => ({ Resource: mocks.resource }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://example/%STAGE%' } }));
vi.mock('@bike4mind/db-core', () => ({ connectDB: mocks.connect }));
vi.mock('@bike4mind/server-utils/analytics/signupBaselineReport', () => ({ runSignupBaselineReport: mocks.report }));
import { handler } from './signupBaselineReport';

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.resource.App.stage = 'production';
  vi.stubEnv('SIGNUP_BASELINE_SINCE', '2026-10-01T00:00:00Z');
  mocks.report.mockResolvedValue({
    window: { since: 'start', until: 'end' },
    total: { signups: 1 },
    census: [{ userId: 'user', timeline: [] }],
  });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('scheduled signup baseline', () => {
  it('skips previews before connecting or querying', async () => {
    mocks.resource.App.stage = 'preview';
    expect(await handler()).toEqual({ status: 'skipped' });
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.report).not.toHaveBeenCalled();
  });

  it('passes configured cutoffs and exclusions to the read-only report and emits separate census records', async () => {
    vi.stubEnv('SIGNUP_BASELINE_SINCE', '2026-10-20T00:00:00Z');
    vi.stubEnv('NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS', 'staff.example.org');
    vi.stubEnv('ANALYTICS_TEST_PATTERN', 'test');
    expect(await handler()).toEqual({ status: 'success', signups: 1 });
    expect(mocks.connect).toHaveBeenCalledWith('mongodb://example/production', undefined, {
      autoIndex: false,
      autoCreate: false,
    });
    expect(mocks.report).toHaveBeenCalledWith({
      since: new Date('2026-10-20T00:00:00Z'),
      until: expect.any(Date),
      staffDomains: 'staff.example.org',
      testPattern: 'test',
    });
    expect(console.log).toHaveBeenCalledTimes(2);
    expect(String(vi.mocked(console.log).mock.calls[0][0])).not.toContain('userId');
    expect(JSON.parse(String(vi.mocked(console.log).mock.calls[1][0]))).toMatchObject({
      report: 'signup-baseline-census',
      userId: 'user',
    });
  });

  it('ends the window at the start of the current UTC day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-26T06:00:00Z'));
    try {
      await handler();
    } finally {
      vi.useRealTimers();
    }
    expect(mocks.report).toHaveBeenCalledWith(expect.objectContaining({ until: new Date('2026-10-26T00:00:00Z') }));
  });

  it('requires a configured post-fix cutoff before connecting', async () => {
    vi.stubEnv('SIGNUP_BASELINE_SINCE', '');
    await expect(handler()).rejects.toThrow();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('throws query failures so the scheduler records a failed invocation', async () => {
    mocks.report.mockRejectedValueOnce(new Error('read failed'));
    await expect(handler()).rejects.toThrow('read failed');
  });
});
