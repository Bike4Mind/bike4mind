// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../../..');
const ADD_CREDITS_REF = /\baddCredits(WithLedgerRow)?\b/;

// Free rewards must draw the trickle pool through creditService.payCreditReward; a direct
// addCredits reference here would pay them unmetered. Value is the call that must appear.
const REWARD_PATHS: Record<string, string> = {
  'apps/client/pages/api/gears/claim.ts': 'payCreditReward(',
  'packages/server-utils/src/referrals/firstAnswerReward.ts': 'payCreditReward(',
  'packages/server-utils/src/referrals/subscriptionReward.ts': 'payCreditReward(',
  'apps/client/server/preferenceArena/index.ts': 'payCreditReward(',
  'apps/client/server/preferenceArena/arenaService.ts': 'deps.payReward(',
};

// Every non-test file that references addCredits, with why it may credit directly. A new
// reward path belongs on payCreditReward, not here.
const DIRECT_CREDIT_ALLOWLIST: Record<string, string> = {
  'b4m-core/services/src/creditService/addCredits.ts': 'definition',
  'b4m-core/services/src/creditService/index.ts': 'barrel re-export',
  'b4m-core/services/src/creditService/payCreditReward.ts': 'the metered reward seam itself',
  'b4m-core/services/src/userService/freeCredits.ts': 'freeCredits pool, own budget',
  'b4m-core/services/src/userService/inviteBonus.ts': 'invite bonus, own budget',
  'b4m-core/services/src/userService/stagedSignupGrant.ts': 'starter/drip grant, own pool',
  'b4m-core/services/src/userService/adminUpdate.ts': 'admin balance edit',
  'apps/client/server/entitlements/signupDomainGrant.ts': 'domain grant, own budget',
  'apps/client/server/partners/bedrocknewsPuzzleReward.ts': 'partner puzzle, own budget',
  'apps/client/server/billing/grantCreditPurchase.ts': 'paid credit purchase',
  'apps/client/server/admin/creditGrants/grantOrg.ts': 'admin grant',
  'apps/client/server/admin/creditGrants/grantSubscription.ts': 'admin grant',
  'apps/client/server/admin/creditGrants/topUpOrg.ts': 'admin grant',
  'apps/client/server/admin/usersBulk/adapters.ts': 'admin bulk grant',
  'apps/client/server/subscriptions/grantIndividualAdminSubscription.ts': 'subscription allowance',
  'apps/workers/src/lib/userSubscriptions/serverUtils.ts': 'subscription allowance',
  'apps/client/pages/api/agents/[id]/transfer-credits.ts': 'agent credit transfer',
  'apps/client/pages/api/organizations/[id]/index.ts': 'org credit transfer',
  'apps/client/server/agents/createAgent.ts': 'agent credit transfer',
  'apps/client/server/agents/deleteAgent.ts': 'agent credit transfer',
  'packages/scripts/backfillPendingFreeCredits.ts': 'ops backfill',
};

// Block comments and whole-line comments only, so prose that names addCredits is not a caller.
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => !line.trimStart().startsWith('//'))
    .join('\n');
}

function referencesAddCredits(path: string): boolean {
  return ADD_CREDITS_REF.test(stripComments(readFileSync(resolve(REPO_ROOT, path), 'utf8')));
}

// git grep, not an fs walk: tracked sources only (no dist/, node_modules), across the monorepo.
function scanDirectCreditFiles(): string[] {
  const out = execFileSync(
    'git',
    [
      'grep',
      '-lwE',
      'addCredits(WithLedgerRow)?',
      '--',
      '*.ts',
      '*.tsx',
      ':!*.test.ts',
      ':!*.test.tsx',
      ':!**/__tests__/**',
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  );
  return out.split('\n').filter(Boolean).filter(referencesAddCredits);
}

describe('direct credit grants', () => {
  const scanned = scanDirectCreditFiles();

  it('finds the known callers (the scan is not vacuous)', () => {
    expect(scanned).toContain('b4m-core/services/src/creditService/addCredits.ts');
    expect(scanned.length).toBeGreaterThan(5);
  });

  it('every file that references addCredits is allowlisted with a reason', () => {
    const unlisted = scanned.filter(path => !(path in DIRECT_CREDIT_ALLOWLIST));
    expect(
      unlisted,
      'route free rewards through creditService.payCreditReward, or allowlist the file with a reason'
    ).toEqual([]);
  });

  it.each(Object.keys(DIRECT_CREDIT_ALLOWLIST))('allowlist entry %s still references addCredits', path => {
    expect(existsSync(resolve(REPO_ROOT, path)), `${path} no longer exists; drop it from the allowlist`).toBe(true);
    expect(scanned, `${path} no longer calls addCredits; drop it from the allowlist`).toContain(path);
  });
});

describe('free reward paths', () => {
  it.each(Object.entries(REWARD_PATHS))('%s pays through the metered seam', (path, seam) => {
    const source = readFileSync(resolve(REPO_ROOT, path), 'utf8');
    expect(source).toContain(seam);
    expect(stripComments(source)).not.toMatch(ADD_CREDITS_REF);
    expect(path in DIRECT_CREDIT_ALLOWLIST).toBe(false);
  });
});
