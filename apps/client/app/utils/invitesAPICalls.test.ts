import { describe, expect, it, vi } from 'vitest';
import { AxiosError } from 'axios';
import { api } from '@client/app/contexts/ApiContext';
import { fetchInvite } from './invitesAPICalls';

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: vi.fn() } }));

const httpError = (status: number) => new AxiosError('fail', 'ERR', undefined, undefined, { status } as never);

describe('fetchInvite', () => {
  it('returns the invite body on success', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { name: 'Doc' } });
    await expect(fetchInvite('x')).resolves.toEqual({ name: 'Doc' });
  });

  it('returns null on a 404', async () => {
    vi.mocked(api.get).mockRejectedValue(httpError(404));
    await expect(fetchInvite('x')).resolves.toBeNull();
  });

  it("returns 'expired' on a 410", async () => {
    vi.mocked(api.get).mockRejectedValue(httpError(410));
    await expect(fetchInvite('x')).resolves.toBe('expired');
  });

  it('rethrows any other error', async () => {
    vi.mocked(api.get).mockRejectedValue(httpError(500));
    await expect(fetchInvite('x')).rejects.toThrow('fail');
  });
});
