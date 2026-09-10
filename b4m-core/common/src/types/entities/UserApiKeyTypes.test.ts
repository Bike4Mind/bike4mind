import { describe, it, expect } from 'vitest';
import { ApiKeyScope, CONFINED_API_KEY_SCOPES } from './UserApiKeyTypes';

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
]);

const EXPECTED_NOT_CONFINED: ReadonlySet<ApiKeyScope> = new Set([
  ApiKeyScope.READ_NOTEBOOKS,
  ApiKeyScope.WRITE_NOTEBOOKS,
  ApiKeyScope.READ_FILES,
  ApiKeyScope.WRITE_FILES,
  ApiKeyScope.AI_GENERATE,
  ApiKeyScope.AI_CHAT,
  ApiKeyScope.READ_PROJECTS,
  ApiKeyScope.WRITE_PROJECTS,
  ApiKeyScope.ADMIN,
  ApiKeyScope.MARKETING_REPORTS_READ,
  ApiKeyScope.MARKETING_REPORTS_WRITE,
  ApiKeyScope.HEARTH_READ,
  ApiKeyScope.HEARTH_WRITE,
  ApiKeyScope.OPTIHASHI_READ,
  ApiKeyScope.OPTIHASHI_COMPUTE,
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
