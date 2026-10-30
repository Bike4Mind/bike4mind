import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { repository, counts } = vi.hoisted(() => ({
  repository: { findByTrackingToken: vi.fn(), recordClick: vi.fn() },
  counts: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  emailSendAttemptRepository: repository,
  emailJobRepository: { incrementCounts: counts },
}));
vi.mock('@server/middlewares/baseApi', () => ({ baseApi: () => ({ get: (handler: unknown) => handler }) }));
import handler from '../[token]';

const token = '2b9a24be-5e94-4bac-83bb-f99d1cc84808';
const target = 'https://example.com/read?name=hello%20world&next=%2Fhome';
const issuedHtml = `<a href="https://app.example.com/api/email/track/click/${token}?url=${encodeURIComponent(target)}">Read</a>`;
const run = async (url: unknown = target, trackingToken: unknown = token) => {
  const { req, res } = createMocks({ method: 'GET', query: { token: trackingToken, url } });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
  return res;
};

beforeEach(() => {
  vi.resetAllMocks();
  repository.findByTrackingToken.mockResolvedValue({ renderedHtml: issuedHtml });
  repository.recordClick.mockResolvedValue({ jobId: 'job1' });
});

describe('issued email click redirect', () => {
  it('rejects a fabricated token without redirecting or writing tracking data', async () => {
    repository.findByTrackingToken.mockResolvedValue(null);
    const res = await run();
    expect(res._getStatusCode()).toBe(404);
    expect(res._getRedirectUrl()).toBeFalsy();
    expect(repository.recordClick).not.toHaveBeenCalled();
  });
  it('rejects a substituted destination even with a real token', async () => {
    expect((await run('https://attacker.example'))._getStatusCode()).toBe(404);
    expect(repository.recordClick).not.toHaveBeenCalled();
  });
  it('preserves percent encoding and redirects only to the issued destination', async () => {
    const res = await run();
    expect(res._getStatusCode()).toBe(302);
    expect(res._getRedirectUrl()).toBe(target);
    expect(repository.recordClick).toHaveBeenCalledWith(token, target);
    expect(counts).toHaveBeenCalledWith('job1', 'clickedCount');
  });
  it('fails closed when token lookup fails', async () => {
    repository.findByTrackingToken.mockRejectedValue(new Error('Database unavailable'));
    await expect(run()).rejects.toThrow('Database unavailable');
    expect(repository.recordClick).not.toHaveBeenCalled();
  });
  it('keeps a verified link usable when aggregate analytics fail', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      counts.mockRejectedValue(new Error('Analytics unavailable'));
      const res = await run();
      expect(res._getStatusCode()).toBe(302);
      expect(res._getRedirectUrl()).toBe(target);
      expect(log).toHaveBeenCalledWith('Failed to count verified email click:', expect.any(Error));
    } finally {
      log.mockRestore();
    }
  });
  it('rejects array query values', async () => {
    await expect(run([target, 'https://attacker.example'])).rejects.toThrow('Invalid tracking link');
  });
});
