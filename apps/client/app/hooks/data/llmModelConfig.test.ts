import { describe, it, expect, vi } from 'vitest';
import type { ModelInfo } from '@bike4mind/common';
import { BASE_ENTITLEMENT_KEY } from '@client/lib/entitlements/registry';

// getDefaultModelConfig is a pure function, but its module pulls in React-Query
// hooks + app contexts at import time; mock those so the unit stays isolated.
vi.mock('@client/app/contexts/ApiContext', () => ({ api: {} }));
vi.mock('@client/app/contexts/AdminSettingsContext', () => ({ useAdminSettings: () => ({ refetch: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { getDefaultModelConfig } from './llmModelConfig';

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
});
