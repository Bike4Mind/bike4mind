import { describe, it, expect, vi } from 'vitest';
import axios, { AxiosError, AxiosHeaders, type AxiosAdapter } from 'axios';
import { registerMfaEnrollmentInterceptor } from './mfaEnrollmentInterceptor';

const respondWith =
  (status: number, data: unknown): AxiosAdapter =>
  async config => {
    const response = { status, statusText: '', data, headers: {}, config: { ...config, headers: new AxiosHeaders() } };
    throw new AxiosError('failed', String(status), response.config, undefined, response);
  };

describe('registerMfaEnrollmentInterceptor', () => {
  it('reports an enrollment-required 403 and still rejects the request', async () => {
    const client = axios.create({ adapter: respondWith(403, { mfaEnrollmentRequired: true }) });
    const onRefusal = vi.fn();
    registerMfaEnrollmentInterceptor(client, onRefusal);

    await expect(client.get('/api/quests')).rejects.toMatchObject({ response: { status: 403 } });
    expect(onRefusal).toHaveBeenCalledTimes(1);
  });

  it.each([
    [403, { code: 'step_up_required' }],
    [401, { mfaEnrollmentRequired: true }],
  ])('ignores a %s that is not the enrollment refusal', async (status, data) => {
    const client = axios.create({ adapter: respondWith(status, data) });
    const onRefusal = vi.fn();
    registerMfaEnrollmentInterceptor(client, onRefusal);

    await expect(client.get('/api/quests')).rejects.toBeDefined();
    expect(onRefusal).not.toHaveBeenCalled();
  });

  it('stops reporting once ejected', async () => {
    const client = axios.create({ adapter: respondWith(403, { mfaEnrollmentRequired: true }) });
    const onRefusal = vi.fn();
    registerMfaEnrollmentInterceptor(client, onRefusal)();

    await expect(client.get('/api/quests')).rejects.toBeDefined();
    expect(onRefusal).not.toHaveBeenCalled();
  });
});
