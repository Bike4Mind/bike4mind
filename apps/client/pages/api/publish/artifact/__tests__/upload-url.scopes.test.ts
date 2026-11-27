import { describe, it, expect, vi } from 'vitest';
import { ApiKeyScope } from '@bike4mind/common';

const mockRefs = vi.hoisted(() => ({ options: null as unknown }));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: Record<string, unknown> = {};
  const self = new Proxy(chain, { get: () => () => self });
  return {
    baseApi: (options: unknown) => {
      mockRefs.options = options;
      return self;
    },
  };
});

import '../upload-url';

describe('upload-url -- API key scope posture', () => {
  it('declares artifacts:publish or admin and grandfathers legacy keys', () => {
    expect(mockRefs.options).toMatchObject({
      requiredScopes: [ApiKeyScope.ARTIFACTS_PUBLISH, ApiKeyScope.ADMIN],
      grandfatherLegacyKeys: true,
    });
  });
});
