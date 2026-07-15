import { describe, it, expect } from 'vitest';
import { ApiKeyScope } from '@bike4mind/common';
import { USER_API_KEY_SCOPES, GENERIC_MODAL_API_KEY_SCOPES, DEDICATED_FLOW_SCOPES } from './apiKeyScopes';

describe('apiKeyScopes catalog', () => {
  const userValues = USER_API_KEY_SCOPES.map(s => s.value);
  const genericValues = GENERIC_MODAL_API_KEY_SCOPES.map(s => s.value);

  it('documents embed:chat in the user-selectable catalog', () => {
    expect(userValues).toContain(ApiKeyScope.EMBED_CHAT);
  });

  it('excludes embed:chat from the generic New-Key modals (dedicated embed flow only)', () => {
    expect(DEDICATED_FLOW_SCOPES.has(ApiKeyScope.EMBED_CHAT)).toBe(true);
    expect(genericValues).not.toContain(ApiKeyScope.EMBED_CHAT);
  });

  it('generic catalog is exactly the user catalog minus the dedicated-flow scopes', () => {
    expect(GENERIC_MODAL_API_KEY_SCOPES).toHaveLength(USER_API_KEY_SCOPES.length - DEDICATED_FLOW_SCOPES.size);
    expect(genericValues).toEqual(userValues.filter(v => !DEDICATED_FLOW_SCOPES.has(v)));
  });
});
