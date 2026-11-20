import { afterEach, describe, it, expect, vi } from 'vitest';
const h = vi.hoisted(() => ({ run: vi.fn(), connect: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ connectDB: h.connect }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://example/%STAGE%' } }));
vi.mock('sst', () => ({ Resource: { App: { stage: 'dev' } } }));
vi.mock('@server/admin/morningBrief', () => ({ runMorningBrief: h.run, morningBriefDeps: {} }));
import { handler } from './adminMorningBrief';
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
describe('morning brief scheduler', () => {
  it('is disabled without explicit opt in', async () => {
    vi.stubEnv('ADMIN_MORNING_BRIEF_ENABLED', '');
    expect(await handler({})).toEqual({ status: 'disabled' });
    expect(h.connect).not.toHaveBeenCalled();
  });
  it('retains the event day when an event is replayed later', async () => {
    vi.stubEnv('ADMIN_MORNING_BRIEF_ENABLED', 'true');
    vi.stubEnv('APP_URL', 'https://example.test');
    h.run.mockResolvedValue('already_attempted');
    await handler({ time: '2026-11-10T08:00:00Z' });
    expect(h.run).toHaveBeenCalledWith(
      expect.objectContaining({ environment: 'dev', now: new Date('2026-11-10T08:00:00Z') }),
      {}
    );
  });
});
