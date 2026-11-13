import { afterEach, describe, it, expect, vi } from 'vitest';
import { ApiKeyScope } from '@bike4mind/common';
import {
  assertApiKeyScope,
  decideScopeGate,
  holdsApiKeyScope,
  isLegacyApiKey,
  LEGACY_API_KEY_WINDOW,
  LEGACY_SCOPE_PASS_LOG,
  parseStagedScopes,
  SCOPE_STAGING_ENV_VAR,
  shouldLogLegacyPass,
} from './apiKeyScopeGate';

vi.mock('../premium-generated/premiumApiKeyScopes.generated', () => ({
  premiumApiKeyScopes: [
    { value: 'acme:read', label: 'Acme: Read', description: 'Read Acme records', endpoints: ['GET /api/acme'] },
  ],
}));

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

  describe('Bob scopes', () => {
    // The two gate shapes these scopes are built for (the routes ship in the Bob overlay,
    // not here): a door that admits either scope, and a run-only gate on the verbs that
    // start work. Held scopes are the stored strings a key carries, so these also pin the
    // wire values.
    const BOB_DOOR = [ApiKeyScope.BOB_READ, ApiKeyScope.BOB_RUN, ApiKeyScope.ADMIN];
    const BOB_RUN_GATE = [ApiKeyScope.BOB_RUN, ApiKeyScope.ADMIN];
    const held = (...scopes: string[]) => scopes as ApiKeyScope[];

    it('admits a bob:run key at a door requiring bob:read or bob:run, and refuses a notebooks-only key', () => {
      expect(decideScopeGate(BOB_DOOR, held('bob:run'), NONE)).toEqual({ outcome: 'allow' });
      expect(decideScopeGate(BOB_DOOR, held('bob:read'), NONE)).toEqual({ outcome: 'allow' });
      expect(decideScopeGate(BOB_DOOR, held('notebooks:read'), NONE)).toEqual({ outcome: 'deny' });
    });

    it('refuses a bob:read key where bob:run is required - reading never implies spending', () => {
      expect(decideScopeGate(BOB_RUN_GATE, held('bob:read'), NONE)).toEqual({ outcome: 'deny' });
      // Control: the same gate admits the scope it names, so the refusal is about bob:read.
      expect(decideScopeGate(BOB_RUN_GATE, held('bob:run'), NONE)).toEqual({ outcome: 'allow' });
    });
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

describe('contributed scopes', () => {
  it('stages a contributed scope and still rejects an unknown one', () => {
    const { staged, rejected } = parseStagedScopes('acme:read,acme:write');
    expect([...staged]).toEqual(['acme:read']);
    expect(rejected).toEqual(['acme:write']);
  });

  it('allows a key holding the contributed scope and denies one without it', () => {
    expect(decideScopeGate(['acme:read'], ['acme:read'], NONE)).toEqual({ outcome: 'allow' });
    expect(decideScopeGate(['acme:read'], [ApiKeyScope.READ_NOTEBOOKS], NONE)).toEqual({ outcome: 'deny' });
  });

  it('lets a key without the contributed scope through only while it is staged', () => {
    const { staged } = parseStagedScopes('acme:read');
    expect(decideScopeGate(['acme:read'], [ApiKeyScope.READ_NOTEBOOKS], staged)).toEqual({
      outcome: 'stagedAllow',
      stagedScopes: ['acme:read'],
    });
  });

  it('does not treat a contributed-only key as confined on a scope-less route', () => {
    expect(decideScopeGate(undefined, ['acme:read'], NONE)).toEqual({ outcome: 'allow' });
  });

  it('still denies a confined key on a contributed route, staged or not', () => {
    const { staged } = parseStagedScopes('acme:read');
    expect(decideScopeGate(['acme:read'], [ApiKeyScope.EMBED_CHAT], staged)).toEqual({ outcome: 'deny' });
    expect(decideScopeGate(['acme:read'], [ApiKeyScope.EMBED_CHAT, 'acme:read'], NONE)).toEqual({ outcome: 'allow' });
  });
});

describe('isLegacyApiKey', () => {
  const cutoff = new Date('2027-01-01T00:00:00Z');
  const endsAt = new Date('2027-04-01T00:00:00Z');
  const before = new Date('2026-12-31T00:00:00Z');
  const after = new Date('2027-01-02T00:00:00Z');
  const midWindow = new Date('2027-02-01T00:00:00Z');

  it('ships with no cutoff and no end date, so every key is legacy until the dates are set', () => {
    expect(LEGACY_API_KEY_WINDOW).toEqual({ cutoff: null, endsAt: null });
    expect(isLegacyApiKey(after)).toBe(true);
    expect(isLegacyApiKey(undefined)).toBe(true);
  });

  it('counts only keys created before the cutoff once it is set', () => {
    const window = { cutoff, endsAt };
    expect(isLegacyApiKey(before, midWindow, window)).toBe(true);
    expect(isLegacyApiKey(cutoff, midWindow, window)).toBe(false);
    expect(isLegacyApiKey(after, midWindow, window)).toBe(false);
  });

  it('fails closed for a key with no creation date once a cutoff is set', () => {
    expect(isLegacyApiKey(undefined, midWindow, { cutoff, endsAt })).toBe(false);
  });

  it('ends for every key at the end date, with no deploy', () => {
    const window = { cutoff, endsAt };
    expect(isLegacyApiKey(before, endsAt, window)).toBe(false);
    expect(isLegacyApiKey(before, new Date('2027-05-01T00:00:00Z'), window)).toBe(false);
    expect(isLegacyApiKey(before, endsAt, { cutoff: null, endsAt })).toBe(false);
  });
});

describe('decideScopeGate grandfathering', () => {
  const required = [ApiKeyScope.ME_READ];

  it('legacy-allows a grandfathered key that misses the required scope', () => {
    expect(decideScopeGate(required, [ApiKeyScope.AI_GENERATE], NONE, undefined, { grandfathered: true })).toEqual({
      outcome: 'legacyAllow',
    });
    expect(decideScopeGate(required, [], NONE, undefined, { grandfathered: true }).outcome).toBe('legacyAllow');
  });

  it('denies the same key when the route or the key is not grandfathered', () => {
    expect(
      decideScopeGate(required, [ApiKeyScope.AI_GENERATE], NONE, undefined, { grandfathered: false }).outcome
    ).toBe('deny');
    expect(decideScopeGate(required, [ApiKeyScope.AI_GENERATE], NONE).outcome).toBe('deny');
  });

  it('prefers a real hold, so the log lists only keys that still need a new key', () => {
    expect(decideScopeGate(required, [ApiKeyScope.ME_READ], NONE, undefined, { grandfathered: true }).outcome).toBe(
      'allow'
    );
  });

  it('reports a staged pass over a legacy one, so the key stays on the staging backlog', () => {
    expect(
      decideScopeGate(required, [ApiKeyScope.AI_GENERATE], new Set([ApiKeyScope.ME_READ]), undefined, {
        grandfathered: true,
      })
    ).toEqual({
      outcome: 'stagedAllow',
      stagedScopes: required,
    });
  });

  it('never admits a confined key', () => {
    expect(decideScopeGate(required, [ApiKeyScope.EMBED_CHAT], NONE, undefined, { grandfathered: true }).outcome).toBe(
      'deny'
    );
  });

  it('never covers a missing AND scope', () => {
    expect(
      decideScopeGate(required, [ApiKeyScope.ME_READ], NONE, [ApiKeyScope.AI_GENERATE], { grandfathered: true }).outcome
    ).toBe('deny');
  });

  it('still denies an empty required list', () => {
    expect(decideScopeGate([], [ApiKeyScope.AI_GENERATE], NONE, undefined, { grandfathered: true }).outcome).toBe(
      'deny'
    );
  });
});

describe('holdsApiKeyScope grandfathering', () => {
  const keyReq = (scopes: ApiKeyScope[]) => {
    const info = vi.fn();
    return { req: { apiKeyInfo: { keyId: 'k1', scopes, createdAt: new Date('2026-01-01') }, logger: { info } }, info };
  };

  it('admits a legacy key that opts in and logs the pass', () => {
    const { req, info } = keyReq([ApiKeyScope.READ_NOTEBOOKS]);
    expect(holdsApiKeyScope(req, [ApiKeyScope.WRITE_NOTEBOOKS], { grandfatherLegacyKeys: true })).toBe(true);
    expect(info).toHaveBeenCalledWith(LEGACY_SCOPE_PASS_LOG, {
      keyId: 'k1',
      heldScopes: [ApiKeyScope.READ_NOTEBOOKS],
      requiredScopes: [ApiKeyScope.WRITE_NOTEBOOKS],
    });
  });

  it('refuses the same key without the option, and logs nothing', () => {
    const { req, info } = keyReq([ApiKeyScope.READ_NOTEBOOKS]);
    expect(() => assertApiKeyScope(req, [ApiKeyScope.WRITE_NOTEBOOKS], 'write needed')).toThrow('write needed');
    expect(info).not.toHaveBeenCalled();
  });

  it('does not log a key that holds the scope', () => {
    const { req, info } = keyReq([ApiKeyScope.WRITE_NOTEBOOKS]);
    expect(holdsApiKeyScope(req, [ApiKeyScope.WRITE_NOTEBOOKS], { grandfatherLegacyKeys: true })).toBe(true);
    expect(info).not.toHaveBeenCalled();
  });
});

describe('shouldLogLegacyPass', () => {
  it('logs a key and route once per hour', () => {
    const t0 = 1_000_000_000;
    expect(shouldLogLegacyPass('dedupe-key', '/api/x', t0)).toBe(true);
    expect(shouldLogLegacyPass('dedupe-key', '/api/x', t0 + 59 * 60 * 1000)).toBe(false);
    expect(shouldLogLegacyPass('dedupe-key', '/api/y', t0)).toBe(true);
    expect(shouldLogLegacyPass('dedupe-key', '/api/x', t0 + 60 * 60 * 1000)).toBe(true);
  });
});

describe('exchange keys', () => {
  const held = [ApiKeyScope.AI_GENERATE, ApiKeyScope.ME_READ];

  it('denies an exchange key on a scope-less route, staged or not', () => {
    expect(decideScopeGate(undefined, held, NONE, undefined, { exchangeKey: true })).toEqual({ outcome: 'deny' });
    expect(
      decideScopeGate([ApiKeyScope.READ_NOTEBOOKS], held, new Set([ApiKeyScope.READ_NOTEBOOKS]), undefined, {
        exchangeKey: true,
      })
    ).toEqual({
      outcome: 'deny',
    });
  });

  it('allows an exchange key on a route that names one of its scopes', () => {
    expect(decideScopeGate([ApiKeyScope.ME_READ], held, NONE, undefined, { exchangeKey: true })).toEqual({
      outcome: 'allow',
    });
  });

  it('leaves a personal key with the same scopes on the scope-less default', () => {
    expect(decideScopeGate(undefined, held, NONE)).toEqual({ outcome: 'allow' });
  });

  it('denies an exchange key on a grandfathered route, whatever it holds', () => {
    const required = [ApiKeyScope.READ_NOTEBOOKS];
    expect(decideScopeGate(required, held, NONE, undefined, { exchangeKey: true, grandfathered: true })).toEqual({
      outcome: 'deny',
    });
    expect(decideScopeGate(required, held, NONE, undefined, { grandfathered: true })).toEqual({
      outcome: 'legacyAllow',
    });
    expect(decideScopeGate(required, held, NONE, undefined, { grandfathered: false })).toEqual({ outcome: 'deny' });
  });

  it('allows an exchange key that explicitly matches on a grandfathered route', () => {
    expect(
      decideScopeGate([ApiKeyScope.ME_READ], held, NONE, undefined, { exchangeKey: true, grandfathered: true })
    ).toEqual({ outcome: 'allow' });
  });

  describe('in-handler check', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('applies the same rule, including while the required scope is staged', () => {
      vi.stubEnv(SCOPE_STAGING_ENV_VAR, ApiKeyScope.READ_NOTEBOOKS);
      expect(parseStagedScopes(process.env[SCOPE_STAGING_ENV_VAR]).staged.has(ApiKeyScope.READ_NOTEBOOKS)).toBe(true);
      const exchange = { apiKeyInfo: { scopes: held, oauthExchangeClientId: 'client-1' } };
      expect(holdsApiKeyScope(exchange, [ApiKeyScope.AI_GENERATE])).toBe(true);
      expect(holdsApiKeyScope(exchange, [ApiKeyScope.READ_NOTEBOOKS])).toBe(false);
      expect(holdsApiKeyScope({ apiKeyInfo: { scopes: held } }, [ApiKeyScope.READ_NOTEBOOKS])).toBe(true);
    });
  });
});
