import { describe, expect, it } from 'vitest';
import { parseProviderSpendScope } from './providerSpendScope';

describe('parseProviderSpendScope', () => {
  it.each([undefined, '', '  ', 'org', '{}'])('treats %j as organization-wide', raw => {
    expect(parseProviderSpendScope('anthropic', raw)).toBeUndefined();
  });

  it('parses a provider scope', () => {
    expect(parseProviderSpendScope('anthropic', '{"workspaceIds":["wrkspc_a","default"]}')).toEqual({
      workspaceIds: ['wrkspc_a', 'default'],
    });
    expect(parseProviderSpendScope('openai', '{"projectIds":["proj_a"],"apiKeyIds":["key_a"]}')).toEqual({
      projectIds: ['proj_a'],
      apiKeyIds: ['key_a'],
    });
  });

  it('rejects invalid JSON rather than falling back to organization-wide', () => {
    expect(() => parseProviderSpendScope('openai', '{projectIds:')).toThrow('openai spend scope is not valid JSON');
  });

  it('rejects a dimension the provider does not have', () => {
    expect(() => parseProviderSpendScope('anthropic', '{"projectIds":["proj_a"]}')).toThrow(
      'anthropic spend scope is invalid'
    );
  });

  it('rejects an empty id list', () => {
    expect(() => parseProviderSpendScope('openai', '{"projectIds":[]}')).toThrow('openai spend scope is invalid');
  });
});
