// @vitest-environment node
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
   * scopes once shipped dead. Registering a new scope means adding it to one of the
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

  it('keeps every spend scope out of the read and read/write presets', () => {
    // The presets are built from the `:read`/`:write` suffixes (UserApiKeysTab), so a scope that
    // commissions billable work must not carry one - otherwise a "Read-only" or "Read & write" key
    // silently gains the ability to spend. Table, not one-off asserts, so a future spend scope
    // (the way `datalake:query` joined `optihashi:compute`) has to be added here to pass.
    const spendScopes = [ApiKeyScope.OPTIHASHI_COMPUTE, ApiKeyScope.DATALAKE_QUERY];
    for (const scope of spendScopes) {
      expect(scope.endsWith(':read'), `${scope} must not end in :read`).toBe(false);
      expect(scope.endsWith(':write'), `${scope} must not end in :write`).toBe(false);
    }
  });

  it('makes overwatch:read user-mintable and lands it in the read-only preset', () => {
    // The `:read` suffix is what puts a scope in the Read-only preset (UserApiKeysTab),
    // which is the default selection for a new key - so every key minted through the
    // profile UI will carry this one. That is deliberate and safe: the scope authorizes
    // but does not entitle, and `requestHasOverwatchAccess` still refuses a key whose
    // owner holds neither admin, the developer tag, nor `overwatch:pro`. Same bargain
    // `hearth:read` and `optihashi:read` already take.
    expect(genericValues).toContain(ApiKeyScope.OVERWATCH_READ);
    expect(ApiKeyScope.OVERWATCH_READ.endsWith(':read')).toBe(true);
  });

  it('keeps the Overwatch read scope distinct from the ingest write scope', () => {
    // Not a read/write pair: the ingest scope is a per-product credential bound to one
    // productId that can write that product's stats, and is admin-provisioned only.
    // An explorer that could also report would be able to fabricate what it reports on.
    expect(ApiKeyScope.OVERWATCH_READ).not.toBe(ApiKeyScope.OVERWATCH_INGEST_WRITE);
    expect(genericValues).not.toContain(ApiKeyScope.OVERWATCH_INGEST_WRITE);
    expect(ADMIN_ONLY_API_KEY_SCOPES.map(s => s.value)).toContain(ApiKeyScope.OVERWATCH_INGEST_WRITE);
  });
});
