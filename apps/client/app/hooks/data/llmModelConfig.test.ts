import { beforeEach, describe, it, expect, vi } from 'vitest';
import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ModelInfo } from '@bike4mind/common';
import { toast } from 'sonner';
import { BASE_ENTITLEMENT_KEY } from '@bike4mind/server-utils/lib/entitlements/registry';

// getDefaultModelConfig is a pure function, but its module pulls in React-Query
// hooks + app contexts at import time; mock those so the unit stays isolated.
const requests = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: requests }));
beforeEach(() => {
  vi.clearAllMocks();
  requests.get.mockReset().mockResolvedValue({ data: { settingValue: [] } });
  requests.put.mockReset();
});
vi.mock('@client/app/contexts/AdminSettingsContext', () => ({ useAdminSettings: () => ({ refetch: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import {
  getDefaultModelConfig,
  useLLMModelConfigurationsWithDefaults,
  useSaveLLMModelConfigurations,
} from './llmModelConfig';

const makeModelInfo = (overrides: Partial<ModelInfo> = {}): ModelInfo =>
  ({ id: 'test-model', name: 'Test Model', type: 'text', ...overrides }) as ModelInfo;

describe('getDefaultModelConfig', () => {
  it('makes a base model public via the reserved base entitlement, not a proxy tag set', () => {
    const config = getDefaultModelConfig(makeModelInfo());

    // No per-user tag requirement: a tag-less account reaches it via `base`.
    expect(config.allowedUserTags).toEqual([]);
    expect(config.allowedEntitlements).toEqual([BASE_ENTITLEMENT_KEY]);
  });

  it('enables a non-private model and disables a private one', () => {
    expect(getDefaultModelConfig(makeModelInfo({ private: false })).enabled).toBe(true);
    expect(getDefaultModelConfig(makeModelInfo({ private: true })).enabled).toBe(false);
  });

  it('never defaults a catalog-disabled model to enabled', () => {
    expect(getDefaultModelConfig(makeModelInfo({ disabled: true })).enabled).toBe(false);
    expect(getDefaultModelConfig(makeModelInfo({ disabled: false })).enabled).toBe(true);
  });
});

describe('useLLMModelConfigurationsWithDefaults - loading state', () => {
  const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
    React.createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      children
    );

  it('stops loading once the model-info query has failed, so the no-models warning can show', async () => {
    const { result } = renderHook(() => useLLMModelConfigurationsWithDefaults(undefined, false), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toEqual([]);
  });

  it('keeps loading while the model-info query is still pending', async () => {
    const { result } = renderHook(() => useLLMModelConfigurationsWithDefaults(undefined, true), { wrapper });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(result.current.isLoading).toBe(true);
  });
});

describe('model configuration transport and picker recovery', () => {
  const model = makeModelInfo();
  const saved = {
    id: model.id,
    enabled: true,
    allowedUserTags: [],
    allowedEntitlements: ['base'],
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
  const response = (revision: string, enabled = true) => ({
    data: { settingValue: [{ ...saved, enabled }] },
    headers: { 'x-model-access-revision': revision },
  });
  const wrapperFor = (client: QueryClient) => {
    const ModelConfigurationTestProvider = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client }, children);
    return ModelConfigurationTestProvider;
  };

  it('reconciles a push during the actual first picker fetch against its returned header', async () => {
    const { handleModelAccessRevisionSetting, watchModelAccessArrivals, MODEL_CONFIGURATIONS_QUERY_KEY } =
      await import('./modelAccessRevision');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const stop = watchModelAccessArrivals(client);
    let finish: ((value: ReturnType<typeof response>) => void) | undefined;
    requests.get
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finish = resolve;
          })
      )
      .mockResolvedValue(response('r2', false));
    const view = renderHook(() => useLLMModelConfigurationsWithDefaults([model]), { wrapper: wrapperFor(client) });
    await waitFor(() => expect(requests.get).toHaveBeenCalledOnce());
    handleModelAccessRevisionSetting(client, { settingName: 'modelAccessRevision', settingValue: 'r2' });
    if (!finish) throw new Error('First picker read did not start');
    await act(async () => {
      finish?.(response('r1'));
    });
    await waitFor(() => expect(view.result.current.data[0]?.enabled).toBe(false));
    expect(requests.get).toHaveBeenCalledTimes(2);
    expect(view.result.current.data[0]?.accessEntry?.updatedAt).toBe(saved.updatedAt);
    expect(client.getQueryData(MODEL_CONFIGURATIONS_QUERY_KEY)).toMatchObject({ revision: 'r2' });
    view.unmount();
    stop();
    client.clear();
  });

  it('exposes a failed access read without granting catalog defaults and recovers on its own retry', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    requests.get.mockRejectedValueOnce(new Error('Access unavailable')).mockResolvedValue(response('r1'));
    const view = renderHook(() => useLLMModelConfigurationsWithDefaults([model]), { wrapper: wrapperFor(client) });
    await waitFor(() => expect(view.result.current.error).toBeTruthy());
    expect(view.result.current.data).toEqual([]);
    expect(view.result.current.isLoading).toBe(false);
    await act(async () => {
      await view.result.current.refetch();
    });
    await waitFor(() => expect(view.result.current.data).toHaveLength(1));
    expect(view.result.current.error).toBeNull();
    view.unmount();
    client.clear();
  });

  it('sends only the validated conditional contract and acknowledges the returned stamps', async () => {
    const client = new QueryClient();
    const onSaved = vi.fn();
    const entry = { ...saved, enabled: false, updatedAt: '2026-11-02T00:00:00.000Z' };
    const result = { entries: [{ id: saved.id, entry }], changed: 1, revision: 'r2' };
    requests.put.mockResolvedValue({ data: result });
    const hook = renderHook(() => useSaveLLMModelConfigurations(onSaved), { wrapper: wrapperFor(client) });
    const request = {
      changes: [{ id: saved.id, change: { enabled: false }, expectedUpdatedAt: saved.updatedAt }],
      reason: 'Update model access',
    };
    await act(async () => {
      await hook.result.current.mutateAsync(request);
    });
    expect(requests.put).toHaveBeenCalledWith('/api/admin/llm-models/configurations', request);
    expect(onSaved).toHaveBeenCalledWith(result);
    hook.unmount();
    client.clear();
  });
  it('surfaces the server reload instruction and leaves a refused save unacknowledged', async () => {
    const client = new QueryClient();
    const onSaved = vi.fn();
    const failure = Object.assign(new Error('Request failed with status code 409'), {
      isAxiosError: true,
      response: { status: 409, data: { error: 'Reload this page before saving.' } },
    });
    requests.put.mockRejectedValue(failure);
    const hook = renderHook(() => useSaveLLMModelConfigurations(onSaved), { wrapper: wrapperFor(client) });
    await act(async () => {
      await expect(hook.result.current.mutateAsync({ changes: [], reason: 'Update model access' })).rejects.toBe(
        failure
      );
    });
    expect(toast.error).toHaveBeenCalledWith('Failed to save configurations: Reload this page before saving.');
    expect(onSaved).not.toHaveBeenCalled();
    hook.unmount();
    client.clear();
  });
});
