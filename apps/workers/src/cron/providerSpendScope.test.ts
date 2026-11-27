import { describe, expect, it, vi } from 'vitest';
import { describeProviderSpendScope, readProviderSpendScope, type ScopeParameterReader } from './providerSpendScope';

const reader = (value: string | undefined): ScopeParameterReader & { getParameter: ReturnType<typeof vi.fn> } => ({
  getParameter: vi.fn(async () => value),
});

describe('readProviderSpendScope', () => {
  it('reads the scope from the SSM parameter named by the env var', async () => {
    const ssm = reader('{"projectIds":["proj_prod"]}');

    const scope = await readProviderSpendScope('openai', ssm, {
      PROVIDER_SPEND_SCOPE_PARAMETER_OPENAI: '/app/production/provider-spend-scope/openai',
    });

    expect(ssm.getParameter).toHaveBeenCalledExactlyOnceWith('/app/production/provider-spend-scope/openai');
    expect(scope).toEqual({ projectIds: ['proj_prod'] });
  });

  it('treats the parameter default as organization-wide', async () => {
    const scope = await readProviderSpendScope('anthropic', reader('org'), {
      PROVIDER_SPEND_SCOPE_PARAMETER_ANTHROPIC: '/app/production/provider-spend-scope/anthropic',
    });
    expect(scope).toBeUndefined();
  });

  it('reads the JSON from the value env var where no parameter exists (self-host)', async () => {
    const ssm = reader(undefined);

    const scope = await readProviderSpendScope('anthropic', ssm, {
      PROVIDER_SPEND_SCOPE_ANTHROPIC: '{"workspaceIds":["default"]}',
    });

    expect(ssm.getParameter).not.toHaveBeenCalled();
    expect(scope).toEqual({ workspaceIds: ['default'] });
  });

  it('is organization-wide when nothing is configured', async () => {
    expect(await readProviderSpendScope('openai', reader(undefined), {})).toBeUndefined();
  });

  it('propagates a failed parameter read instead of widening to the organization', async () => {
    const ssm: ScopeParameterReader = { getParameter: vi.fn(async () => Promise.reject(new Error('AccessDenied'))) };
    await expect(
      readProviderSpendScope('openai', ssm, { PROVIDER_SPEND_SCOPE_PARAMETER_OPENAI: '/p' })
    ).rejects.toThrow('AccessDenied');
  });

  it('rejects an invalid value', async () => {
    await expect(
      readProviderSpendScope('anthropic', reader('{"projectIds":["p"]}'), {
        PROVIDER_SPEND_SCOPE_PARAMETER_ANTHROPIC: '/p',
      })
    ).rejects.toThrow('anthropic spend scope is invalid');
  });
});

describe('describeProviderSpendScope', () => {
  it('names the scoped dimensions and their sizes without the ids', () => {
    expect(describeProviderSpendScope(undefined)).toBe('org');
    expect(describeProviderSpendScope({ workspaceIds: ['a', 'b'], apiKeyIds: ['k'] })).toBe(
      'workspaceIds:2,apiKeyIds:1'
    );
  });
});
