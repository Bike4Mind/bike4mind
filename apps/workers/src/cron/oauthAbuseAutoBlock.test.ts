import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ connectDB: vi.fn(), run: vi.fn() }));

vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://x/%STAGE%' } }));
vi.mock('@bike4mind/database', () => ({ connectDB: h.connectDB }));
vi.mock('@bike4mind/server-utils/security/oauthAbuseAutoBlock', () => ({ runOauthAbuseAutoBlock: h.run }));

import { handler } from './oauthAbuseAutoBlock';
import { registerOauthAbuseAutoBlock } from '../selfhost/oauthAbuseAutoBlock';

describe('oauthAbuseAutoBlock cron', () => {
  afterEach(() => vi.clearAllMocks());

  it('connects to the stage database, then runs the shared runner', async () => {
    h.run.mockResolvedValue({ evaluatedSince: new Date(), blocked: [], failed: [] });
    await handler();
    expect(h.connectDB).toHaveBeenCalledWith('mongodb://x/test');
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.connectDB.mock.invocationCallOrder[0]).toBeLessThan(h.run.mock.invocationCallOrder[0]);
  });

  it('logs an error when some IPs failed to block', async () => {
    h.run.mockResolvedValue({ evaluatedSince: new Date(), blocked: [], failed: ['1.1.1.1'] });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await handler();
    expect(error).toHaveBeenCalledWith('[oauthAbuseAutoBlock] failed to block', ['1.1.1.1']);
  });

  it('registers a 1-minute self-host task that runs on startup', async () => {
    const registerScheduledTask = vi.fn();
    registerOauthAbuseAutoBlock({ registerScheduledTask });
    const [name, interval, fn, opts] = registerScheduledTask.mock.calls[0];
    expect([name, interval, opts]).toEqual(['oauthAbuseAutoBlock', 60_000, { runOnStartup: true }]);
    h.run.mockResolvedValue({ blocked: [], failed: [] });
    await fn();
    expect(h.run).toHaveBeenCalledTimes(1);
  });
});
