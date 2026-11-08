import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

// Operator backfills pay grants that were already owed, so they stay off the daily pools on purpose.
const UNMETERED_BACKFILLS = [
  'packages/scripts/backfillOAuthStartingGrant.ts',
  'packages/scripts/backfillPendingFreeCredits.ts',
];

/**
 * reserveSignupGrantBudget pays unmetered when `signupProtection.grantBudget` is absent, so every runtime
 * adapter set (client, hosted workers and self-host, which import it from the package) must use the
 * shared packages/server-utils/src/auth/signupProtection.ts rather than build its own literal.
 */
describe('signup grant budget wiring', () => {
  it('wires the budget repository on the shared signupProtection adapter', () => {
    const source = readFileSync(join(root, 'packages/server-utils/src/auth/signupProtection.ts'), 'utf8');
    expect(source).toMatch(/grantBudget:\s*\{\s*get repository\(\)\s*\{\s*return signupGrantBudgetRepository;/);
  });

  it('builds no other signupProtection adapter literal outside the listed backfills', () => {
    const stdout = execFileSync(
      'git',
      [
        'grep',
        '-lE',
        'signupProtection:[[:space:]]*[{]',
        '--',
        'apps',
        'packages',
        'b4m-core',
        ':!*.test.ts',
        ':!*.test.tsx',
        ':!**/__tests__/**',
      ],
      { cwd: root, encoding: 'utf8' }
    );
    const literals = stdout.split('\n').filter(Boolean).sort();
    expect(literals).toEqual(UNMETERED_BACKFILLS);
  });
});
