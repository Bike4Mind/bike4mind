// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AxiosError, type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { api } from '@client/app/contexts/ApiContext';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { useStepUpStore } from '@client/app/stores/useStepUpStore';

// The real `api` with its real interceptors (401 refresh, step-up); only the transport is faked.
const { mockRefreshSession } = vi.hoisted(() => ({ mockRefreshSession: vi.fn() }));
vi.mock('@client/app/utils/refreshCoordinator', () => ({ refreshSession: mockRefreshSession }));
vi.mock('@client/app/utils/clearClientCaches', () => ({ clearClientCaches: vi.fn().mockResolvedValue(undefined) }));

import StepUpModal from './StepUpModal';

type Reply = { status: number; data: unknown };

const respond = (config: InternalAxiosRequestConfig, { status, data }: Reply): Promise<AxiosResponse> => {
  const response = { status, statusText: '', data, headers: {}, config } as AxiosResponse;
  if (status < 400) return Promise.resolve(response);
  return Promise.reject(new AxiosError('failed', 'ERR_BAD_REQUEST', config, {}, response));
};

const appTheme = extendTheme({ ...getThemeConfig() });

describe('StepUpModal with the real HTTP client', () => {
  let realAdapter: AxiosAdapter | undefined;
  let calls: string[];

  /** Routes `METHOD url` to the next queued reply for it (the last one repeats). */
  const installRoutes = (routes: Record<string, Reply[]>) => {
    api.defaults.adapter = ((config: InternalAxiosRequestConfig) => {
      const key = `${config.method?.toUpperCase()} ${config.url}`;
      calls.push(key);
      const queue = routes[key];
      if (!queue) throw new Error(`Unexpected request ${key}`);
      return respond(config, queue.length > 1 ? queue.shift()! : queue[0]);
    }) as AxiosAdapter;
  };

  beforeEach(() => {
    calls = [];
    realAdapter = api.defaults.adapter as AxiosAdapter | undefined;
    mockRefreshSession.mockReset().mockResolvedValue({ accessToken: 'token' });
    useAccessToken.setState({ accessToken: 'token', expired: false, expiredReason: null, mfaPending: false });
    useStepUpStore.setState({ open: false, pending: null, resolvePending: null, rejectPending: null });
    render(
      <CssVarsProvider theme={appTheme}>
        <StepUpModal />
      </CssVarsProvider>
    );
  });

  afterEach(() => {
    api.defaults.adapter = realAdapter;
  });

  it('prompts on step_up_required, then replays the original request once', async () => {
    installRoutes({
      'POST /api/email/change': [
        { status: 403, data: { error: 'Recent verification required', code: 'step_up_required' } },
        { status: 200, data: { ok: true } },
      ],
      'GET /api/auth/step-up/options': [{ status: 200, data: { methods: ['password'], stepUpUntil: null } }],
      'POST /api/auth/step-up': [{ status: 200, data: { stepUpUntil: new Date().toISOString() } }],
    });

    const request = api.post('/api/email/change', { newEmail: 'new@example.com' });
    fireEvent.change(await screen.findByTestId('step-up-modal-password-input'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByTestId('step-up-modal-password-verify-btn'));

    await expect(request).resolves.toMatchObject({ status: 200, data: { ok: true } });
    expect(calls.filter(call => call === 'POST /api/email/change')).toHaveLength(2);
    expect(calls.filter(call => call === 'POST /api/auth/step-up')).toHaveLength(1);
  });

  it('shows a rejected proof without refreshing, replaying it, or ending the session', async () => {
    installRoutes({
      'POST /api/email/change': [
        { status: 403, data: { error: 'Recent verification required', code: 'step_up_required' } },
      ],
      'GET /api/auth/step-up/options': [{ status: 200, data: { methods: ['password'], stepUpUntil: null } }],
      'POST /api/auth/step-up': [{ status: 400, data: { error: 'Incorrect password.', code: 'step_up_failed' } }],
    });

    void api.post('/api/email/change', {}).catch(() => undefined);
    fireEvent.change(await screen.findByTestId('step-up-modal-password-input'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByTestId('step-up-modal-password-verify-btn'));

    expect((await screen.findByTestId('step-up-modal-error')).textContent).toContain('Incorrect password.');
    expect(calls.filter(call => call === 'POST /api/auth/step-up')).toHaveLength(1);
    expect(mockRefreshSession).not.toHaveBeenCalled();
    expect(useAccessToken.getState().expired).toBe(false);
    expect(useStepUpStore.getState().open).toBe(true);
  });

  it('(harness control) a code-less 401 from the same route does go through refresh and replay', async () => {
    installRoutes({
      'POST /api/auth/step-up': [
        { status: 401, data: { error: 'Authentication required' } },
        { status: 200, data: { stepUpUntil: 'x' } },
      ],
    });

    await expect(api.post('/api/auth/step-up', { method: 'password', password: 'x' })).resolves.toMatchObject({
      status: 200,
    });
    await waitFor(() => expect(mockRefreshSession).toHaveBeenCalledTimes(1));
    expect(calls).toEqual(['POST /api/auth/step-up', 'POST /api/auth/step-up']);
  });
});
