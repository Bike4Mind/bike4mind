// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { ApiKeyScope, CONFINED_API_KEY_SCOPES } from '@bike4mind/common';
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
    // profile UI will carry this one. The suffix is deliberate, not incidental: the
    // surface behind it reads and nothing more, so it belongs in that preset, where
    // `datalake:query` and `optihashi:compute` deliberately go unsuffixed to stay out.
    // If a tool reachable through the Overwatch MCP route ever mutates or spends, this
    // scope has to lose the suffix too - and the spend-scope table above will not catch
    // that, because it only iterates the scopes already listed in it.
    //
    // Safe in that default preset because the scope authorizes without entitling. The
    // check that makes that true (`requestHasOverwatchAccess`) lives in the Overwatch
    // overlay package and has no implementation here, so this repo cannot test it and
    // this test does not claim to: it asserts only the catalog placement it can see.
    // Same bargain `hearth:read` and `optihashi:read` already take.
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

/**
 * The client catalogs and the shared confined list (@bike4mind/common) are read by
 * different halves of the system - these surfaces decide what a user may ask for, the
 * shared constant decides what the mint service and the runtime gate will accept - so
 * they can only stay honest if something asserts the overlap. DEDICATED_FLOW_SCOPES is
 * now derived from it; these tests pin the invariants that derivation buys and the ones
 * it cannot enforce on its own.
 */
describe('apiKeyScopes vs the shared CONFINED_API_KEY_SCOPES', () => {
  const genericValues = GENERIC_MODAL_API_KEY_SCOPES.map(s => s.value);

  it('never offers a confined scope in the generic New-Key modals', () => {
    // The invariant that actually protects a user: `createUserApiKey` refuses a key that
    // mixes a confined scope with any other, and the modals are multi-select - so a
    // confined scope on that list is a selection the mint route rejects. The derivation
    // makes this hold by construction today; the test is what notices if someone unpicks
    // it - re-hand-lists DEDICATED_FLOW_SCOPES, or builds the modal list from some other
    // filter.
    for (const scope of CONFINED_API_KEY_SCOPES) {
      expect(genericValues, `${scope} is confined and must not be offered in the generic modals`).not.toContain(scope);
    }
  });

  it('derives DEDICATED_FLOW_SCOPES as exactly the confined scopes documented for users', () => {
    const documentedConfined = USER_API_KEY_SCOPES.map(s => s.value).filter(v => CONFINED_API_KEY_SCOPES.includes(v));
    expect([...DEDICATED_FLOW_SCOPES].sort()).toEqual([...documentedConfined].sort());
  });

  it('gives every confined scope a home in exactly one client catalog', () => {
    // Where the derivation stops: a confined scope kept out of the user catalog still has
    // to be registered as admin-only or non-mintable by hand, or it is a scope no surface
    // here can mint. Same failure mode the coverage test above guards, narrowed to the
    // scopes whose handling the shared constant already has an opinion about.
    const adminValues = ADMIN_ONLY_API_KEY_SCOPES.map(s => s.value);
    for (const scope of CONFINED_API_KEY_SCOPES) {
      const homes = [
        DEDICATED_FLOW_SCOPES.has(scope) && 'dedicated-flow',
        adminValues.includes(scope) && 'admin-only',
        NON_MINTABLE_API_KEY_SCOPES.has(scope) && 'non-mintable',
      ].filter(Boolean);
      expect(homes, `confined scope ${scope} must be registered in exactly one client catalog`).toHaveLength(1);
    }
  });

  it('keeps admin:* out of the confined list and inside the non-mintable one', () => {
    // The pair that shows confinement and mintability are different questions, and why
    // NON_MINTABLE_API_KEY_SCOPES cannot simply be derived: `admin:*` is broad by design
    // (never confined) yet may never be minted from any surface here.
    expect(CONFINED_API_KEY_SCOPES).not.toContain(ApiKeyScope.ADMIN);
    expect(NON_MINTABLE_API_KEY_SCOPES.has(ApiKeyScope.ADMIN)).toBe(true);
  });
});
