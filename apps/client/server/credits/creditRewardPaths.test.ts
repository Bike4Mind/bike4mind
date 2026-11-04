// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Free rewards must draw the trickle pool through creditService.payCreditReward; a direct
// addCredits call here would pay them unmetered.
const REWARD_PATHS = ['pages/api/gears/claim.ts', 'server/referrals/firstAnswerReward.ts'];

describe('free reward paths', () => {
  it.each(REWARD_PATHS)('%s pays through payCreditReward, never addCredits directly', path => {
    const source = readFileSync(resolve(__dirname, '../..', path), 'utf8');
    expect(source).toContain('payCreditReward(');
    expect(source).not.toMatch(/\baddCredits(WithLedgerRow)?\(/);
  });
});
