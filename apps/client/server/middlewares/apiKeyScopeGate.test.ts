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

  it('denies a confined key on a route requiring some other scope', () => {
    expect(decideScopeGate([ApiKeyScope.AI_CHAT], [ApiKeyScope.EMBED_CHAT], NONE)).toEqual({ outcome: 'deny' });
  });

  it('allows a confined key on the route that names its scope', () => {
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
});
