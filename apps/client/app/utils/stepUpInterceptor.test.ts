import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AxiosError, type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { api } from '@client/app/contexts/ApiContext';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { useStepUpStore } from '@client/app/stores/useStepUpStore';

vi.mock('@client/app/utils/clearClientCaches', () => ({ clearClientCaches: vi.fn().mockResolvedValue(undefined) }));

const failWith = (config: InternalAxiosRequestConfig, status: number, data: unknown): AxiosError =>
  new AxiosError('failed', 'ERR_BAD_REQUEST', config, {}, {
    status,
    statusText: '',
    data,
    headers: {},
    config,
  } as AxiosResponse);

const stepUpRequired = { error: 'Recent verification required', code: 'step_up_required' };
const ok = (config: InternalAxiosRequestConfig): AxiosResponse =>
  ({ data: { done: true }, status: 200, statusText: 'OK', headers: {}, config }) as AxiosResponse;

describe('step-up response interceptor', () => {
  let realAdapter: AxiosAdapter | undefined;
  let calls: string[];

  // Fails with step_up_required until the store reports a completed verification.
  const installAdapter = (gate: () => boolean) => {
    api.defaults.adapter = ((config: InternalAxiosRequestConfig) => {
      calls.push(config.url ?? '');
      return gate() ? Promise.resolve(ok(config)) : Promise.reject(failWith(config, 403, stepUpRequired));
    }) as AxiosAdapter;
  };

  beforeEach(() => {
    calls = [];
    realAdapter = api.defaults.adapter as AxiosAdapter | undefined;
    useAccessToken.setState({ accessToken: 'token', expired: false, expiredReason: null, mfaPending: false });
    useStepUpStore.setState({ open: false, pending: null, resolvePending: null, rejectPending: null });
  });

  afterEach(() => {
    api.defaults.adapter = realAdapter;
    vi.restoreAllMocks();
  });

  it('opens the prompt on step_up_required and retries once after verification', async () => {
    let verified = false;
    installAdapter(() => verified);

    const request = api.post('/api/email/change', {});
    await vi.waitFor(() => expect(useStepUpStore.getState().open).toBe(true));
    verified = true;
    useStepUpStore.getState().completeStepUp();

    await expect(request).resolves.toMatchObject({ status: 200 });
    expect(calls).toEqual(['/api/email/change', '/api/email/change']);
  });

  it('rejects with the original error when the user cancels', async () => {
    installAdapter(() => false);

    const request = api.post('/api/email/change', {});
    await vi.waitFor(() => expect(useStepUpStore.getState().open).toBe(true));
    useStepUpStore.getState().cancelStepUp();

    await expect(request).rejects.toMatchObject({ response: { status: 403, data: stepUpRequired } });
    expect(calls).toHaveLength(1);
  });

  it('shares one prompt between concurrent requests and retries each', async () => {
    let verified = false;
    installAdapter(() => verified);
    const requestPrompt = vi.spyOn(useStepUpStore.getState(), 'requestStepUp');

    const first = api.post('/api/a', {});
    const second = api.post('/api/b', {});
    await vi.waitFor(() => expect(requestPrompt).toHaveBeenCalledTimes(2));
    verified = true;
    useStepUpStore.getState().completeStepUp();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(calls.sort()).toEqual(['/api/a', '/api/a', '/api/b', '/api/b']);
  });

  it('does not loop when the retry is still refused', async () => {
    installAdapter(() => false);

    const request = api.post('/api/email/change', {});
    await vi.waitFor(() => expect(useStepUpStore.getState().open).toBe(true));
    useStepUpStore.getState().completeStepUp();

    await expect(request).rejects.toMatchObject({ response: { status: 403 } });
    expect(calls).toHaveLength(2);
    expect(useStepUpStore.getState().open).toBe(false);
  });

  it('leaves other 403s alone', async () => {
    api.defaults.adapter = ((config: InternalAxiosRequestConfig) =>
      Promise.reject(failWith(config, 403, { error: 'Forbidden' }))) as AxiosAdapter;

    await expect(api.get('/api/x')).rejects.toMatchObject({ response: { status: 403 } });
    expect(useStepUpStore.getState().open).toBe(false);
  });

  it('never intercepts the step-up routes themselves', async () => {
    installAdapter(() => false);

    await expect(api.post('/api/auth/step-up', {})).rejects.toMatchObject({ response: { status: 403 } });
    expect(useStepUpStore.getState().open).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('does not prompt for an unauthenticated request', async () => {
    useAccessToken.setState({ accessToken: null });
    installAdapter(() => false);

    await expect(api.post('/api/email/change', {})).rejects.toMatchObject({ response: { status: 403 } });
    expect(useStepUpStore.getState().open).toBe(false);
  });
});
