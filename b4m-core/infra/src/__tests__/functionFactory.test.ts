import { describe, it, expect } from 'vitest';
import { buildFunctionDefaults, stageGatedConcurrency } from '../functionFactory.js';

describe('buildFunctionDefaults', () => {
  it('returns the standard runtime/logging defaults with an empty environment', () => {
    expect(buildFunctionDefaults()).toEqual({
      runtime: 'nodejs24.x',
      logging: { retention: '3 days' },
      environment: {},
    });
  });

  it('merges extraEnvironment over the base environment', () => {
    const defaults = buildFunctionDefaults({
      environment: { NODE_OPTIONS: '--enable-source-maps', STAGE: 'dev' },
      extraEnvironment: { STAGE: 'production', APP_URL: 'https://example.com' },
    });
    expect(defaults.environment).toEqual({
      NODE_OPTIONS: '--enable-source-maps',
      STAGE: 'production',
      APP_URL: 'https://example.com',
    });
  });

  it('supports runtime and log retention overrides', () => {
    expect(buildFunctionDefaults({ runtime: 'nodejs22.x', logRetention: '1 week' })).toEqual({
      runtime: 'nodejs22.x',
      logging: { retention: '1 week' },
      environment: {},
    });
  });

  it('spreads under per-function overrides without leaking shared state', () => {
    const a = buildFunctionDefaults();
    const b = buildFunctionDefaults();
    a.environment.MUTATED = 'true';
    expect(b.environment).toEqual({});
  });
});

describe('stageGatedConcurrency', () => {
  it('returns the concurrency on production and dev', () => {
    expect(stageGatedConcurrency('production', { reserved: 10 })).toEqual({ reserved: 10 });
    expect(stageGatedConcurrency('dev', { reserved: 10 })).toEqual({ reserved: 10 });
  });

  it('returns undefined on ephemeral stages', () => {
    expect(stageGatedConcurrency('pr-123', { reserved: 10 })).toBeUndefined();
  });

  it('honors custom gated stages', () => {
    expect(stageGatedConcurrency('staging', { reserved: 2 }, ['staging'])).toEqual({ reserved: 2 });
    expect(stageGatedConcurrency('production', { reserved: 2 }, ['staging'])).toBeUndefined();
  });
});
