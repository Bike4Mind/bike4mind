import { describe, it, expect } from 'vitest';
import { leadingNonPassing, stateKeyFilter } from './streak';

const run = (status: 'passed' | 'failed' | 'infra-error', iso: string) => ({ status, startedAt: new Date(iso) });

describe('leadingNonPassing', () => {
  it('counts the newest non-passing streak and when it began', () => {
    expect(
      leadingNonPassing([
        run('failed', '2026-09-28'),
        run('infra-error', '2026-09-27'),
        run('passed', '2026-09-26'),
        run('failed', '2026-09-25'),
      ])
    ).toEqual({ count: 2, since: new Date('2026-09-27') });
  });
  it('is zero when the newest run passed', () => {
    expect(leadingNonPassing([run('passed', '2026-09-28'), run('failed', '2026-09-27')])).toEqual({ count: 0 });
  });
});

describe('stateKeyFilter', () => {
  it('matches runs without a tenant when the key has none', () => {
    expect(stateKeyFilter({ product: 'product-a', suite: 'Core', env: 'staging', branch: 'main' })).toEqual({
      product: 'product-a',
      suite: 'Core',
      env: 'staging',
      branch: 'main',
      tenant: { $exists: false },
    });
  });
  it('matches the tenant when set', () => {
    expect(
      stateKeyFilter({ product: 'product-a', tenant: 'tenant-a', suite: 'Core', env: 'staging', branch: 'main' }).tenant
    ).toBe('tenant-a');
  });
});
