import { describe, expect, it, vi } from 'vitest';
const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('@workers/cron/apiKeyExpiryReminder', () => ({ runApiKeyExpiryReminder: run }));
import { registerApiKeyExpiryReminder } from './apiKeyExpiryReminder';

describe('local API key expiry reminder schedule', () => {
  const register = () => {
    const registerDailyUtcTask = vi.fn();
    registerApiKeyExpiryReminder({ registerDailyUtcTask });
    return registerDailyUtcTask;
  };

  it('registers a daily task at 14:00 UTC, matching the hosted schedule', () => {
    expect(register()).toHaveBeenCalledWith('apiKeyExpiryReminder', 14, expect.any(Function));
  });

  it('rejects when some reminders were not sent, so the worker logs the failed run', async () => {
    const task = register().mock.calls[0][2] as () => Promise<void>;
    run.mockResolvedValueOnce({ found: 2, reminded: 1, failed: 1 });
    await expect(task()).rejects.toThrow('API key expiry reminder failed for 1 key(s)');
    run.mockResolvedValueOnce({ found: 1, reminded: 1, failed: 0 });
    await expect(task()).resolves.toBeUndefined();
  });
});
