import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * `Resource` is SST's runtime proxy: reading a secret that this stage never linked throws, and the
 * dispatcher must fall back rather than crash the cron. The proxy below reproduces both shapes.
 */
const h = vi.hoisted(() => ({
  stage: 'production',
  sourceDeployment: 'true' as string | undefined,
  secretReadThrows: false,
}));

vi.mock('sst', () => ({
  Resource: new Proxy({} as Record<string, unknown>, {
    get(_target, key) {
      if (key === 'App') return { stage: h.stage };
      if (key !== 'IS_SOURCE_DEPLOYMENT') return undefined;
      if (h.secretReadThrows) throw new Error('Resource is not linked');
      return h.sourceDeployment === undefined ? undefined : { value: h.sourceDeployment };
    },
  }),
}));

// The real module reads Resource.MONGODB_URI at import time and throws outside a linked SST app.
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: {} }));

vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn(),
  liveopsTriageConfigRepository: { findEnabled: vi.fn(async () => []) },
  liveopsTriageConfigAuditLogRepository: { create: vi.fn() },
}));

import { isForkEnvironment } from './liveopsTriageDispatcher';

describe('liveopsTriageDispatcher fork detection', () => {
  beforeEach(() => {
    h.stage = 'production';
    h.sourceDeployment = 'true';
    h.secretReadThrows = false;
  });

  it('is not a fork when the source deployment flag is true', () => {
    expect(isForkEnvironment()).toBe(false);
  });

  it('is a fork when the source deployment flag is false', () => {
    h.sourceDeployment = 'false';
    expect(isForkEnvironment()).toBe(true);
  });

  it('is a fork when the secret is not set on this stage', () => {
    h.sourceDeployment = undefined;
    expect(isForkEnvironment()).toBe(true);
  });

  it('is a fork when reading the secret throws, instead of crashing the cron', () => {
    h.secretReadThrows = true;
    expect(() => isForkEnvironment()).not.toThrow();
    expect(isForkEnvironment()).toBe(true);
  });

  it('is never a fork outside the production stage', () => {
    h.stage = 'dev';
    h.sourceDeployment = 'false';
    expect(isForkEnvironment()).toBe(false);
  });
});
