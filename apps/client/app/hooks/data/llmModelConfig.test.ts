import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ModelInfo } from '@bike4mind/common';
import { BASE_ENTITLEMENT_KEY } from '@client/lib/entitlements/registry';

// getDefaultModelConfig is a pure function, but its module pulls in React-Query
// hooks + app contexts at import time; mock those so the unit stays isolated.
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: vi.fn().mockResolvedValue({ data: { settingValue: [] } }) },
}));
vi.mock('@client/app/contexts/AdminSettingsContext', () => ({ useAdminSettings: () => ({ refetch: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { getDefaultModelConfig, useLLMModelConfigurationsWithDefaults } from './llmModelConfig';

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
