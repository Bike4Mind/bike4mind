import { describe, it, expect } from 'vitest';
import { buildFunctionDefaults, resolveDefaultLogging, stageGatedConcurrency } from '../functionFactory.js';

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

describe('resolveDefaultLogging', () => {
  it('fills in the stage default when logging is unset', () => {
    expect(resolveDefaultLogging(undefined, 'production')).toEqual({ retention: '1 month' });
    expect(resolveDefaultLogging(undefined, 'dev')).toEqual({ retention: '1 week' });
  });

  it('adds the stage default to an existing config', () => {
    expect(resolveDefaultLogging({ format: 'json' }, 'production')).toEqual({ format: 'json', retention: '1 month' });
    expect(resolveDefaultLogging({ format: 'json' }, 'pr4090')).toEqual({ format: 'json', retention: '1 week' });
  });

  it('treats only production as the long-retention stage', () => {
    expect(resolveDefaultLogging({}, 'production')).toEqual({ retention: '1 month' });
    expect(resolveDefaultLogging({}, 'dev')).toEqual({ retention: '1 week' });
    expect(resolveDefaultLogging({}, 'shared-dev')).toEqual({ retention: '1 week' });
  });

  it('leaves an explicit retention untouched', () => {
    expect(resolveDefaultLogging({ retention: '1 day' }, 'production')).toEqual({ retention: '1 day' });
  });

  it('leaves a custom log group untouched (SST rejects logGroup + retention)', () => {
    const logging = { logGroup: '/aws/lambda/x' };
    expect(resolveDefaultLogging(logging, 'dev')).toBe(logging);
  });

  it('leaves logging: false untouched', () => {
    expect(resolveDefaultLogging(false, 'production')).toBe(false);
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
