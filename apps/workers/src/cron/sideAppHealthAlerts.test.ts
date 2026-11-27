import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  collect: vi.fn(),
  reconcile: vi.fn(),
  post: vi.fn(),
  findByClientIds: vi.fn(),
  listOpen: vi.fn(),
  resource: {
    App: { stage: 'dev' },
    SLACK_ALARMS_WEBHOOK_URL: { value: 'https://example.test/alarms' },
    SLACK_ERROR_REPORTING_WEBHOOK_URL: { value: 'https://example.test/errors' },
  },
}));
vi.mock('sst', () => ({ Resource: mocks.resource }));
vi.mock('@bike4mind/database', () => ({
  connectDB: mocks.connect,
  oauthClientRepository: { findByClientIds: mocks.findByClientIds },
  sideAppAlertStateRepository: { listOpen: mocks.listOpen },
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://example/%STAGE%' } }));
vi.mock('@bike4mind/utils', () => ({ postMessageToSlack: mocks.post }));
vi.mock('./sideAppHealth/collect', () => ({ collectClientHealthRows: mocks.collect }));
vi.mock('./sideAppHealth/reconcile', () => ({ reconcileAlerts: mocks.reconcile }));
import { handler } from './sideAppHealthAlerts';

const H = Date.UTC(2026, 10, 18, 11);
const now = new Date(H + 15 * 60_000);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resource.App.stage = 'dev';
  mocks.resource.SLACK_ALARMS_WEBHOOK_URL.value = 'https://example.test/alarms';
  mocks.connect.mockResolvedValue(undefined);
  mocks.collect.mockResolvedValue({ hourly: [], lastHour: [] });
  mocks.reconcile.mockResolvedValue({ opened: 0, reminded: 0, resolved: 0, postFailures: 0 });
  mocks.findByClientIds.mockResolvedValue(new Map());
  mocks.listOpen.mockResolvedValue([]);
});

describe('sideAppHealthAlerts handler', () => {
  it('skips stages other than production and dev without touching the database', async () => {
    mocks.resource.App.stage = 'preview';
    expect(await handler({ time: now.toISOString() })).toEqual({ status: 'skipped' });
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('rethrows a connect error so the run lands in the dead-letter queue', async () => {
    mocks.connect.mockRejectedValue(new Error('connect ECONNREFUSED'));
    await expect(handler({ time: now.toISOString() })).rejects.toThrow('connect ECONNREFUSED');
    expect(mocks.collect).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it('rethrows a query error instead of reporting a quiet fleet', async () => {
    mocks.collect.mockRejectedValue(new Error('operation exceeded time limit'));
    await expect(handler({ time: now.toISOString() })).rejects.toThrow('operation exceeded time limit');
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it('does nothing when no alarm webhook is configured', async () => {
    mocks.resource.SLACK_ALARMS_WEBHOOK_URL.value = 'not-configured';
    mocks.resource.SLACK_ERROR_REPORTING_WEBHOOK_URL.value = 'not-configured';
    expect(await handler({ time: now.toISOString() })).toEqual({ status: 'skipped', reason: 'missing-webhook' });
    expect(mocks.collect).not.toHaveBeenCalled();
  });

  it('evaluates the rows and reconciles the desired alerts', async () => {
    mocks.collect.mockResolvedValue({
      hourly: [],
      lastHour: [{ source: 'refusal', clientId: 'app', hourStart: 0, count: 20, reason: 'server_error' }],
    });
    const result = await handler({ time: now.toISOString() });
    expect(result).toMatchObject({ status: 'success' });
    expect(mocks.reconcile).toHaveBeenCalledTimes(1);
    const [desired, ctx] = mocks.reconcile.mock.calls[0];
    expect(desired).toEqual([]);
    expect(ctx.now).toEqual(now);
    mocks.post.mockResolvedValue(true);
    await ctx.post({ text: 't', blocks: [] });
    expect(mocks.post).toHaveBeenCalledWith('https://example.test/alarms', { text: 't', blocks: [] });
  });
});
