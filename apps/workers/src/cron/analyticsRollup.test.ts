import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { ScheduledEvent } from 'aws-lambda';

const mocks = vi.hoisted(() => ({ connect: vi.fn(), run: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ connectDB: mocks.connect }));
vi.mock('@server/analytics/analyticsRollup', () => ({ runNightlyRollup: mocks.run }));
vi.mock('sst', () => ({ Resource: { App: { name: 'test', stage: 'dev' } } }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://localhost/%STAGE%' } }));

import { handler } from './analyticsRollup';

const event = { time: '2026-06-02T04:00:00Z' } as ScheduledEvent;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connect.mockResolvedValue(undefined);
});

describe('analytics rollup cron', () => {
  it('rolls up using the scheduled time', async () => {
    mocks.run.mockResolvedValue({ day: '2026-06-01', dau: 1, wau: 1, mau: 1 });
    await handler(event);
    expect(mocks.run).toHaveBeenCalledWith(event.time, expect.anything());
  });

  it('rethrows so the async-invoke DLQ receives the failure', async () => {
    mocks.run.mockRejectedValue(new Error('boom'));
    await expect(handler(event)).rejects.toThrow('boom');
  });

  it('is wired with a DLQ on the function and the schedule target', () => {
    const source = readFileSync(new URL('../../../../infra/analyticsRollup.ts', import.meta.url), 'utf8');
    expect(source).toContain("handler: 'apps/workers/src/cron/analyticsRollup.handler'");
    expect(source).toContain('deadLetterConfig: { targetArn: failures.arn }');
    expect(source).toContain('deadLetterConfig: { arn: failures.arn }');
    expect(source).toContain("'cron(0 4 * * ? *)'");
    expect(source).toContain('if (runsScheduledJobs)');
  });
});
