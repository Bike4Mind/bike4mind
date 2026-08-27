import { describe, it, expect } from 'vitest';
import { ApiKeyScope } from '@bike4mind/common';
import {
  USER_API_KEY_SCOPES,
  GENERIC_MODAL_API_KEY_SCOPES,
  DEDICATED_FLOW_SCOPES,
  ADMIN_ONLY_API_KEY_SCOPES,
  NON_MINTABLE_API_KEY_SCOPES,
} from './apiKeyScopes';

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

  /**
   * The guard that makes "add an enum value, forget to register it" impossible:
   * an unregistered scope is one no mint route can ever issue, so no key can ever
   * hold it and every route requiring it is permanently 403 - how the `datalake:*`
   * scopes shipped dead. Registering a new scope means adding it to one of the
   * three lists, and choosing which one is the decision this test forces.
   */
  it('accounts for every ApiKeyScope in exactly one catalog', () => {
    const adminValues = ADMIN_ONLY_API_KEY_SCOPES.map(s => s.value);
    for (const scope of Object.values(ApiKeyScope)) {
      const homes = [
        userValues.includes(scope) && 'user-selectable',
        adminValues.includes(scope) && 'admin-only',
        NON_MINTABLE_API_KEY_SCOPES.has(scope) && 'non-mintable',
      ].filter(Boolean);
      expect(homes, `${scope} must be registered in exactly one catalog`).toHaveLength(1);
    }
  });

  it('registers both halves of the OptiHashi pair as separately mintable', () => {
    expect(genericValues).toContain(ApiKeyScope.OPTIHASHI_READ);
    expect(genericValues).toContain(ApiKeyScope.OPTIHASHI_COMPUTE);
  });

  it('keeps the OptiHashi spend scope out of the read and read/write presets', () => {
    // The presets are built from the `:read`/`:write` suffixes (UserApiKeysTab),
    // so `optihashi:compute` must not carry one - otherwise a "Read & write" key
    // silently gains the ability to commission billable compute.
    expect(ApiKeyScope.OPTIHASHI_COMPUTE.endsWith(':read')).toBe(false);
    expect(ApiKeyScope.OPTIHASHI_COMPUTE.endsWith(':write')).toBe(false);
  });
});
