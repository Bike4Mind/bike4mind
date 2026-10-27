import { describe, it, expect } from 'vitest';
import {
  ApiKeyScope,
  CONFINED_API_KEY_SCOPES,
  PUBLIC_DOC_API_KEY_SCOPES,
  UNDOCUMENTED_API_KEY_SCOPES,
  isBuiltInApiKeyScope,
  isWellFormedApiKeyScope,
} from './UserApiKeyTypes';

/**
 * Exhaustiveness guard for CONFINED_API_KEY_SCOPES. The confined list is hand-maintained, so a
 * newly added dedicated-flow scope that nobody remembers to add here would silently keep the
 * broad-by-default behavior with no test failure to catch it. The two partitions below force
 * every scope to carry a deliberate confined / not-confined answer: add a member to ApiKeyScope
 * and this suite fails until it is classified here - a loud decision instead of a silent miss.
 */
const EXPECTED_CONFINED: ReadonlySet<ApiKeyScope> = new Set([
  ApiKeyScope.CC_BRIDGE,
  ApiKeyScope.EMBED_CHAT,
  ApiKeyScope.OVERWATCH_INGEST_WRITE,
  ApiKeyScope.QA_INGEST,
  ApiKeyScope.SKILLS_READ,
  ApiKeyScope.RELEASE_NOTES_WRITE,
]);

const EXPECTED_NOT_CONFINED: ReadonlySet<ApiKeyScope> = new Set([
  ApiKeyScope.READ_NOTEBOOKS,
  ApiKeyScope.WRITE_NOTEBOOKS,
  ApiKeyScope.READ_FILES,
  ApiKeyScope.WRITE_FILES,
  ApiKeyScope.AI_GENERATE,
  ApiKeyScope.AI_DECIDE,
  ApiKeyScope.AI_CHAT,
  ApiKeyScope.READ_PROJECTS,
  ApiKeyScope.WRITE_PROJECTS,
  ApiKeyScope.READ_AGENTS,
  ApiKeyScope.WRITE_AGENTS,
  ApiKeyScope.ME_READ,
  ApiKeyScope.ADMIN,
  ApiKeyScope.MARKETING_REPORTS_READ,
  ApiKeyScope.MARKETING_REPORTS_WRITE,
  ApiKeyScope.HEARTH_READ,
  ApiKeyScope.HEARTH_WRITE,
  ApiKeyScope.OPTIHASHI_READ,
  ApiKeyScope.OPTIHASHI_COMPUTE,
  ApiKeyScope.DATALAKE_READ,
  ApiKeyScope.DATALAKE_WRITE,
  ApiKeyScope.DATALAKE_SHARE,
  ApiKeyScope.DATALAKE_QUERY,
  ApiKeyScope.OVERWATCH_READ,
  ApiKeyScope.BOB_READ,
  ApiKeyScope.BOB_RUN,
  ApiKeyScope.SKILLS_WRITE,
  ApiKeyScope.SKILLS_REVIEW,
]);

describe('CONFINED_API_KEY_SCOPES', () => {
  it('classifies every ApiKeyScope as confined or not (no scope left undecided)', () => {
    for (const scope of Object.values(ApiKeyScope)) {
      const decided = EXPECTED_CONFINED.has(scope) || EXPECTED_NOT_CONFINED.has(scope);
      expect(decided, `ApiKeyScope "${scope}" has no confined/not-confined decision - classify it here`).toBe(true);
    }
  });

  it('keeps the two partitions disjoint (no scope is both confined and not)', () => {
    for (const scope of EXPECTED_CONFINED) {
      expect(EXPECTED_NOT_CONFINED.has(scope)).toBe(false);
    }
  });

  it('matches the exported CONFINED_API_KEY_SCOPES exactly', () => {
    expect([...CONFINED_API_KEY_SCOPES].sort()).toEqual([...EXPECTED_CONFINED].sort());
  });

  it('never confines admin:* (broad by design)', () => {
    expect(CONFINED_API_KEY_SCOPES).not.toContain(ApiKeyScope.ADMIN);
  });
});

describe('API-key scope value predicates', () => {
  it('accepts every built-in scope as well formed and built in', () => {
    for (const scope of Object.values(ApiKeyScope)) {
      expect(isWellFormedApiKeyScope(scope), scope).toBe(true);
      expect(isBuiltInApiKeyScope(scope), scope).toBe(true);
    }
  });

  it('accepts a contributed shape as well formed but not built in', () => {
    expect(isWellFormedApiKeyScope('acme:read')).toBe(true);
    expect(isWellFormedApiKeyScope('acme-2:bulk-write')).toBe(true);
    expect(isBuiltInApiKeyScope('acme:read')).toBe(false);
  });

  it.each([
    [''],
    ['acme'],
    ['acme:'],
    [':read'],
    ['Acme:read'],
    ['acme:Read'],
    ['acme:read:extra'],
    ['acme:*'],
    ['-acme:read'],
    ['acme :read'],
    ['acme:read\n'],
    [`acme:${'r'.repeat(100)}`],
    [42],
    [null],
    [undefined],
  ])('rejects %j', value => {
    expect(isWellFormedApiKeyScope(value)).toBe(false);
    expect(isBuiltInApiKeyScope(value)).toBe(false);
  });
});

describe('public API reference scope classification', () => {
  const EXPECTED_UNDOCUMENTED: ReadonlySet<ApiKeyScope> = new Set([
    ApiKeyScope.ADMIN,
    ApiKeyScope.CC_BRIDGE,
    ApiKeyScope.EMBED_CHAT,
    ApiKeyScope.OVERWATCH_INGEST_WRITE,
    ApiKeyScope.QA_INGEST,
    ApiKeyScope.RELEASE_NOTES_WRITE,
    ApiKeyScope.OPTIHASHI_READ,
    ApiKeyScope.OPTIHASHI_COMPUTE,
  ]);

  const EXPECTED_PUBLIC: ReadonlySet<ApiKeyScope> = new Set([
    ApiKeyScope.READ_NOTEBOOKS,
    ApiKeyScope.WRITE_NOTEBOOKS,
    ApiKeyScope.READ_FILES,
    ApiKeyScope.WRITE_FILES,
    ApiKeyScope.AI_GENERATE,
    ApiKeyScope.AI_DECIDE,
    ApiKeyScope.AI_CHAT,
    ApiKeyScope.READ_PROJECTS,
    ApiKeyScope.WRITE_PROJECTS,
    ApiKeyScope.READ_AGENTS,
    ApiKeyScope.WRITE_AGENTS,
    ApiKeyScope.ME_READ,
    ApiKeyScope.MARKETING_REPORTS_READ,
    ApiKeyScope.MARKETING_REPORTS_WRITE,
    ApiKeyScope.HEARTH_READ,
    ApiKeyScope.HEARTH_WRITE,
    ApiKeyScope.DATALAKE_READ,
    ApiKeyScope.DATALAKE_WRITE,
    ApiKeyScope.DATALAKE_SHARE,
    ApiKeyScope.DATALAKE_QUERY,
    ApiKeyScope.OVERWATCH_READ,
    ApiKeyScope.BOB_READ,
    ApiKeyScope.BOB_RUN,
    ApiKeyScope.SKILLS_READ,
    ApiKeyScope.SKILLS_WRITE,
    ApiKeyScope.SKILLS_REVIEW,
  ]);

  it('classifies every ApiKeyScope as public or undocumented, so a new scope fails here until decided', () => {
    const classified = [...EXPECTED_PUBLIC, ...EXPECTED_UNDOCUMENTED];
    expect(new Set(classified).size).toBe(classified.length);
    expect([...classified].sort()).toEqual(Object.values(ApiKeyScope).sort());
  });

  it('derives the published and undocumented lists from that classification', () => {
    expect([...PUBLIC_DOC_API_KEY_SCOPES].sort()).toEqual([...EXPECTED_PUBLIC].sort());
    expect(new Set(UNDOCUMENTED_API_KEY_SCOPES)).toEqual(EXPECTED_UNDOCUMENTED);
  });

  it('publishes no confined scope except the customer-minted skills:read', () => {
    for (const scope of CONFINED_API_KEY_SCOPES.filter(s => s !== ApiKeyScope.SKILLS_READ)) {
      expect(PUBLIC_DOC_API_KEY_SCOPES).not.toContain(scope);
    }
  });
});
