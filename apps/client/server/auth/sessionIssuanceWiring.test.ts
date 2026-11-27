import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const routes = [
  '../../pages/api/auth/refreshToken.ts',
  '../../pages/api/oauth/refresh.ts',
  '../../pages/api/otc/verify.ts',
];

const verifyGuardedIssuance = (source: string) => {
  expect(source).not.toMatch(/authSessionService\.issueSession\s*\(/);
  expect(source).toMatch(/issueSessionForRequest\s*\(/);
};

describe('session minting entry points', () => {
  it.each(routes)('keeps every mint in %s behind the purge write guard', filename => {
    const source = readFileSync(new URL(filename, import.meta.url), 'utf8');
    verifyGuardedIssuance(source);
    const calls = [...source.matchAll(/issueSessionForRequest\s*\(/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const mutated =
        source.slice(0, call.index) + 'authSessionService.issueSession(' + source.slice(call.index + call[0].length);
      expect(() => verifyGuardedIssuance(mutated)).toThrow();
    }
  });
});
