import { describe, it, expect, vi } from 'vitest';

/**
 * This route has no other test of its own, so the source-scan guard
 * (filesApiKeyScopeCoverage.test.ts) is direction-blind: it only proves SOME files scope is
 * declared, not that it is the right one. This pins the actual gate.
 */

// baseApi wraps the handler; mock it as a pass-through so importing the route captures the
// options its top-level baseApi(...) call was made with.
const h = vi.hoisted(() => ({ baseApiOptions: undefined as unknown }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    h.baseApiOptions = options;
    return { post: (handler: unknown) => handler };
  },
}));

vi.mock('@bike4mind/database', () => ({ fabFileRepository: { findByContentHashes: vi.fn() } }));

import '../check-duplicates';

describe('POST /api/files/check-duplicates', () => {
  it('requires files:read at the baseApi route gate', () => {
    expect(h.baseApiOptions).toEqual({ requiredScopes: ['files:read'] });
  });
});
