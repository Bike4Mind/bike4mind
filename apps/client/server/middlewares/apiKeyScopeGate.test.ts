import { describe, it, expect } from 'vitest';
import { ApiKeyScope } from '@bike4mind/common';
import { decideScopeGate, parseStagedScopes } from './apiKeyScopeGate';

const NONE = new Set<string>();

describe('parseStagedScopes', () => {
  it('treats an unset or empty list as "nothing is staged"', () => {
    for (const raw of [undefined, '', '  ', ',,']) {
      const { staged, rejected } = parseStagedScopes(raw);
      expect([...staged]).toEqual([]);
      expect(rejected).toEqual([]);
    }
  });

  it('accepts real scope values and tolerates whitespace', () => {
    const { staged, rejected } = parseStagedScopes(' optihashi:read , optihashi:compute ');
    expect([...staged].sort()).toEqual(['optihashi:compute', 'optihashi:read']);
    expect(rejected).toEqual([]);
  });

  it('reports a typo rather than staging it', () => {
    const { staged, rejected } = parseStagedScopes('optihashi:reed');
    expect([...staged]).toEqual([]);
    expect(rejected).toEqual(['optihashi:reed']);
  });

  it('refuses to stage admin or dedicated-flow scopes', () => {
    const unstageable = [
      ApiKeyScope.ADMIN,
      ApiKeyScope.CC_BRIDGE,
      ApiKeyScope.EMBED_CHAT,
      ApiKeyScope.OVERWATCH_INGEST_WRITE,
    ];
    const { staged, rejected } = parseStagedScopes(unstageable.join(','));
    expect([...staged]).toEqual([]);
    expect(rejected).toEqual(unstageable);
  });

  it('keeps the valid entries when one is rejected', () => {
    const { staged, rejected } = parseStagedScopes(`${ApiKeyScope.OPTIHASHI_READ},${ApiKeyScope.ADMIN}`);
    expect([...staged]).toEqual([ApiKeyScope.OPTIHASHI_READ]);
    expect(rejected).toEqual([ApiKeyScope.ADMIN]);
  });
});

describe('decideScopeGate', () => {
  it('allows a scope-less route for an ordinary key', () => {
    expect(decideScopeGate(undefined, [ApiKeyScope.AI_CHAT], NONE)).toEqual({ outcome: 'allow' });
    // No scopes at all is a legacy broad key, not a narrow one - confining it here
    // would be a silent revocation.
    expect(decideScopeGate(undefined, [], NONE)).toEqual({ outcome: 'allow' });
    expect(decideScopeGate(undefined, undefined, NONE)).toEqual({ outcome: 'allow' });
  });

  it('denies a confined key on a scope-less route', () => {
    for (const scope of [ApiKeyScope.EMBED_CHAT, ApiKeyScope.CC_BRIDGE, ApiKeyScope.OVERWATCH_INGEST_WRITE]) {
      expect(decideScopeGate(undefined, [scope], NONE)).toEqual({ outcome: 'deny' });
    }
  });

  it('denies a confined key on a route requiring some other scope, even mid-staging', () => {
    // NONE staged: the deny could also come from the ordinary-miss path, so this half
    // alone does not isolate the confinement branch.
    expect(decideScopeGate([ApiKeyScope.AI_CHAT], [ApiKeyScope.EMBED_CHAT], NONE)).toEqual({ outcome: 'deny' });
    // With that scope staged, only the confinement branch stands between the confined key
    // and a stagedAllow - so this pins line 119: delete it and this flips to stagedAllow.
    // The staged branch warns-and-passes for grandfathered keys, but a confined credential
    // was never grandfathered, so a rollout window must not become a way in.
    const staged = new Set<string>([ApiKeyScope.AI_CHAT]);
    expect(decideScopeGate([ApiKeyScope.AI_CHAT], [ApiKeyScope.EMBED_CHAT], staged)).toEqual({ outcome: 'deny' });
  });

  it('allows a confined key on the route that names its scope (allow-path control, not the confinement branch)', () => {
    // Allow-path control (the explicit-match branch), not a confinement test: confinement
    // must not over-block a confined key from the one route it is meant for.
    expect(decideScopeGate([ApiKeyScope.EMBED_CHAT], [ApiKeyScope.EMBED_CHAT], NONE)).toEqual({ outcome: 'allow' });
  });

  it('does not confine admin:* - it is broad by design', () => {
    expect(decideScopeGate(undefined, [ApiKeyScope.ADMIN], NONE)).toEqual({ outcome: 'allow' });
  });

  it('confines a key that pairs a dedicated scope with an ordinary one', () => {
    // Mintable today, so `some` rather than `every` is what actually closes the hole.
    const mixed = [ApiKeyScope.EMBED_CHAT, ApiKeyScope.AI_CHAT];
    expect(decideScopeGate(undefined, mixed, NONE)).toEqual({ outcome: 'deny' });
    // It keeps whatever a route explicitly names, though - this is a gate, not a revocation.
    expect(decideScopeGate([ApiKeyScope.AI_CHAT], mixed, NONE)).toEqual({ outcome: 'allow' });
  });

  it('still stages normally for an ordinary key', () => {
    const staged = new Set<string>([ApiKeyScope.AI_CHAT]);
    expect(decideScopeGate([ApiKeyScope.AI_CHAT], [ApiKeyScope.READ_NOTEBOOKS], staged)).toEqual({
      outcome: 'stagedAllow',
      stagedScopes: [ApiKeyScope.AI_CHAT],
    });
  });

  it('allows when the key holds any one of the required scopes', () => {
    const required = [ApiKeyScope.OPTIHASHI_READ, ApiKeyScope.OPTIHASHI_COMPUTE];
    expect(decideScopeGate(required, [ApiKeyScope.OPTIHASHI_COMPUTE], NONE)).toEqual({ outcome: 'allow' });
  });

  it('denies when the key holds none of them and none are staged', () => {
    expect(decideScopeGate([ApiKeyScope.OPTIHASHI_COMPUTE], [ApiKeyScope.AI_CHAT], NONE)).toEqual({
      outcome: 'deny',
    });
  });

  it('denies a key with no scopes at all', () => {
    expect(decideScopeGate([ApiKeyScope.OPTIHASHI_READ], undefined, NONE)).toEqual({ outcome: 'deny' });
  });

  it('denies an empty required list - "one of nothing" can satisfy nobody', () => {
    expect(decideScopeGate([], [ApiKeyScope.ADMIN], new Set([ApiKeyScope.OPTIHASHI_READ]))).toEqual({
      outcome: 'deny',
    });
  });

  it('staged-allows only while every required scope is staged', () => {
    const required = [ApiKeyScope.OPTIHASHI_READ, ApiKeyScope.OPTIHASHI_COMPUTE];
    const held = [ApiKeyScope.AI_CHAT];

    expect(decideScopeGate(required, held, new Set(required))).toEqual({
      outcome: 'stagedAllow',
      stagedScopes: required,
    });
    // One alternative already enforced: a key that needs this route could have
    // been minted with it, so there is nothing to grandfather.
    expect(decideScopeGate(required, held, new Set([ApiKeyScope.OPTIHASHI_READ]))).toEqual({ outcome: 'deny' });
  });

  it('prefers a real hold over staging, so the log stays a true backlog', () => {
    expect(
      decideScopeGate([ApiKeyScope.OPTIHASHI_READ], [ApiKeyScope.OPTIHASHI_READ], new Set([ApiKeyScope.OPTIHASHI_READ]))
    ).toEqual({ outcome: 'allow' });
  });

  describe('alsoRequiredScopes (AND)', () => {
    it('allows when both the OR match and every AND scope are held', () => {
      const also = [ApiKeyScope.OPTIHASHI_READ, ApiKeyScope.OPTIHASHI_COMPUTE];
      const held = [ApiKeyScope.AI_CHAT, ...also];
      expect(decideScopeGate([ApiKeyScope.AI_CHAT], held, NONE, also)).toEqual({ outcome: 'allow' });
    });

    it('denies when the OR list matches but an AND scope is missing', () => {
      expect(decideScopeGate([ApiKeyScope.AI_CHAT], [ApiKeyScope.AI_CHAT], NONE, [ApiKeyScope.OPTIHASHI_READ])).toEqual(
        { outcome: 'deny' }
      );
    });

    it('denies for a missing AND scope even on an otherwise scope-less route', () => {
      // requiredScopes undefined would normally allow any ordinary key - the AND
      // gate must still hold even with no OR list declared.
      expect(decideScopeGate(undefined, [ApiKeyScope.AI_CHAT], NONE, [ApiKeyScope.OPTIHASHI_READ])).toEqual({
        outcome: 'deny',
      });
    });

    it('has no staging grace period - a staged AND scope still denies', () => {
      const staged = new Set<string>([ApiKeyScope.OPTIHASHI_READ]);
      expect(
        decideScopeGate([ApiKeyScope.AI_CHAT], [ApiKeyScope.AI_CHAT], staged, [ApiKeyScope.OPTIHASHI_READ])
      ).toEqual({ outcome: 'deny' });
    });

    it('is a no-op when omitted or empty, so every existing 3-arg call keeps its exact behavior', () => {
      expect(decideScopeGate([ApiKeyScope.AI_CHAT], [ApiKeyScope.AI_CHAT], NONE, [])).toEqual({ outcome: 'allow' });
      expect(decideScopeGate([ApiKeyScope.AI_CHAT], [ApiKeyScope.AI_CHAT], NONE, undefined)).toEqual({
        outcome: 'allow',
      });
    });

    it('still denies a confined key that lacks the AND scope, even on its own named route', () => {
      const also = [ApiKeyScope.OPTIHASHI_READ];
      expect(decideScopeGate([ApiKeyScope.EMBED_CHAT], [ApiKeyScope.EMBED_CHAT], NONE, also)).toEqual({
        outcome: 'deny',
      });
    });

    it('still allows a confined key on its own named route once the AND scope is also held', () => {
      const also = [ApiKeyScope.OPTIHASHI_READ];
      const held = [ApiKeyScope.EMBED_CHAT, ApiKeyScope.OPTIHASHI_READ];
      expect(decideScopeGate([ApiKeyScope.EMBED_CHAT], held, NONE, also)).toEqual({ outcome: 'allow' });
    });
  });
});
