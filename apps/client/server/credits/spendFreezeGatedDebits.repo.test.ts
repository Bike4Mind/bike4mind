// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../../..');

// Balance moves, reservations and credit pre-checks are not forced through a spend-freeze decision by the
// type system. Every call site is listed below, once per occurrence, with where its freeze check runs or why
// it needs none, so a new debit fails this test even inside a file that is already listed.
const RULES: Record<string, RegExp> = {
  incrementCredits: /\bincrementCredits\(\s*[^,():]+,\s*-?[\w.]+/g,
  decrementCredits: /\bdecrementCredits(?:Floored|IfCovered)\(\s*[^,():]+,\s*-?[\w.]+/g,
  rawCurrentCreditsInc: /\$inc:\s*\{[^}]*\bcurrentCredits\b[^}]*\}/g,
  holdCredits: /(?<!function )\bholdCredits\(/g,
  imageCreditHolds: /\bcreditHolds\.hold\(/g,
  reserveRequestCredits: /(?<!function )\breserveRequestCredits\(/g,
  holdPreflightCredits: /(?<!function )\bholdPreflightCredits\(/g,
  recordOperationalUsage: /(?<!function )\brecordOperationalUsage\(/g,
  subtractCredits: /(?<!function )\bsubtractCredits\(/g,
  assertOwnerHasCredits: /(?<!function )\bassertOwnerHasCredits\(/g,
};
const PREFILTER_WORDS = [
  ...Object.keys(RULES),
  'decrementCreditsFloored',
  'decrementCreditsIfCovered',
  'currentCredits',
];

const SETTLEMENT = 'settlement of an already-gated request';
const REFUND = 'refund or rollback of a reservation (adds credits)';
const HELPER = 'helper definition; its callers are classified here';
const VIA_RESERVE =
  'gated-by reserveRequestCredits own assertSpendNotFrozen (ahead of its enforceCredits short-circuit)';
const VIA_HOLD = 'gated-by holdCredits own assertSpendNotFrozen';
const VIA_TOOL_HOST = 'gated-by the host chat turn / agent iteration / wake freeze check that runs the tool';
const TRANSFER = "transfer between the user's own balances, not metered spend";
const CLAWBACK = 'clawback of granted credits, not metered spend';

const SITES: Record<string, Array<[call: string, why: string]>> = {
  'apps/client/pages/api/ai/test-realtime-voice.ts': [
    ['holdPreflightCredits(', "gated-by the route's own assertSpendNotFrozen ahead of its credits-enforced gate"],
  ],
  'apps/client/pages/api/ai/music.ts': [['reserveRequestCredits(', VIA_RESERVE]],
  'apps/client/pages/api/blog/generate-featured-image.ts': [['reserveRequestCredits(', VIA_RESERVE]],
  'apps/client/pages/api/help/chat.ts': [
    ['recordOperationalUsage(', 'gated-by the same request reserveCompletionCredits freeze check'],
  ],
  'apps/client/pages/api/stripe/webhook.ts': [['subtractCredits(', CLAWBACK]],
  'apps/client/pages/api/v1/embeddings.ts': [['reserveRequestCredits(', VIA_RESERVE]],
  'apps/client/pages/api/v1/sessions/semantic-search.ts': [
    ['assertOwnerHasCredits(', 'gated-by assertSpendNotFrozen earlier in the route'],
  ],
  'apps/client/server/agents/authoring/generateAgentAvatar.ts': [['reserveRequestCredits(', VIA_RESERVE]],
  'apps/client/server/agents/createAgent.ts': [['subtractCredits(', TRANSFER]],
  'apps/client/server/agents/deleteAgent.ts': [['subtractCredits(', TRANSFER]],
  'apps/client/server/agents/transferCreditsToAgent.ts': [['subtractCredits(', TRANSFER]],
  'apps/client/server/billing/earlyFraudWarning.ts': [['subtractCredits(', CLAWBACK]],
  'apps/client/server/billing/refundClawback.ts': [['subtractCredits(', CLAWBACK]],
  'apps/client/server/chatCompletion/external/embedRoute.ts': [
    ['assertOwnerHasCredits(', 'gated-by assertSpendNotFrozen earlier in the route'],
  ],
  'apps/client/server/dataLakes/runLakeSemanticSearch.ts': [
    ['recordOperationalUsage(', 'gated-by assertSpendNotFrozen earlier in the search'],
  ],
  'apps/client/server/utils/creditPreflight.ts': [['reserveRequestCredits(', VIA_RESERVE]],
  'apps/client/server/utils/transcriptionCost.ts': [
    ['holdPreflightCredits(', `${VIA_RESERVE}; passes the key as spendFreezeApiKey`],
  ],
  'apps/client/server/websocket/voiceSessionEnded.ts': [
    ['incrementCredits(payerId, -credits', SETTLEMENT],
    ['incrementCredits(payerId, delta', SETTLEMENT],
    ['decrementCreditsFloored(payerId, credits', SETTLEMENT],
  ],
  'apps/workers/src/cron/creditLotSweep.ts': [['subtractCredits(', 'expiry of a stale credit lot, not metered spend']],
  'apps/workers/src/dataLakes/runLakeResearch.ts': [
    ['recordOperationalUsage(', 'gated-by assertSpendNotFrozen earlier in the run'],
  ],
  'apps/workers/src/emailIngestion/emailAnalyzer.ts': [
    ['recordOperationalUsage(', 'record-only (bypassCreditBilling)'],
  ],
  'packages/server-utils/src/billing/recordSessionOperationalUsage.ts': [
    [
      'recordOperationalUsage(',
      'gated-by payerCanFundSessionOperation (its freeze refusal) in each session-event handler and by the credit check in the document hand-off',
    ],
  ],
  'apps/workers/src/queueHandlers/fabFileVectorize.ts': [
    ['recordOperationalUsage(', 'record-only (bypassCreditBilling)'],
    ['recordOperationalUsage(', 'record-only (settledCredits from its own reservation)'],
    ['reserveRequestCredits(', VIA_RESERVE],
  ],
  'apps/workers/src/queueHandlers/orgFeedbackSummary.ts': [
    ['recordOperationalUsage(', 'record-only (bypassCreditBilling)'],
  ],
  'apps/workers/src/queueHandlers/questExport.ts': [['recordOperationalUsage(', 'record-only (bypassCreditBilling)']],
  'b4m-core/services/src/billing/recordOperationalUsage.ts': [
    ['decrementCreditsFloored(holderId, params.credits', HELPER],
  ],
  'b4m-core/services/src/cliCompletions.ts': [
    ['incrementCredits(holderId, -reservedCredits', 'gated-by assertSpendNotFrozen ahead of the reservation'],
    ['incrementCredits(holderId, reservedCredits', REFUND],
    ['incrementCredits(holderId, reservedCredits', REFUND],
    ['incrementCredits(holderId, creditDifference', SETTLEMENT],
    ['decrementCreditsFloored(holderId, -creditDifference', SETTLEMENT],
    ['subtractCredits(', SETTLEMENT],
  ],
  'b4m-core/services/src/creditService/addCredits.ts': [
    ['incrementCredits(ownerId, 0', 'balance read, moves nothing'],
    ['incrementCredits(ownerId, credits', 'credit grant (adds credits)'],
  ],
  'b4m-core/services/src/creditService/creditHold.ts': [
    ['incrementCredits(ownerId, -requiredCredits', 'gated-by holdCredits own assertSpendNotFrozen'],
    ['incrementCredits(ownerId, requiredCredits', REFUND],
    ['incrementCredits(ownerId, requiredCredits', REFUND],
    ['incrementCredits(hold.ownerId, hold.reservedCredits', REFUND],
    ['incrementCredits(hold.ownerId, overReserved', REFUND],
  ],
  'b4m-core/services/src/creditService/deductCreditsWithOrgSupport.ts': [['subtractCredits(', HELPER]],
  'b4m-core/services/src/creditService/subtractCredits.ts': [['incrementCredits(ownerId, -credits', HELPER]],
  'b4m-core/services/src/generationJobs/createJob.ts': [
    ['holdCredits(', 'gated-by assertSpendNotFrozen just before the hold'],
  ],
  'b4m-core/services/src/llm/ImageEdit.ts': [
    ['creditHolds.hold(', `${VIA_HOLD}; the credits-off branch runs assertSpendNotFrozen itself`],
  ],
  'b4m-core/services/src/llm/ImageGeneration.ts': [
    ['creditHolds.hold(', `${VIA_HOLD}; the credits-off branch runs assertSpendNotFrozen itself`],
  ],
  'b4m-core/services/src/llm/ChatCompletionProcess.ts': [
    ['incrementCredits(reservationOwnerId, -requiredCredits', 'gated-by the chat turn freeze check before the hold'],
    ['incrementCredits(reservationOwnerId, requiredCredits', REFUND],
    ['incrementCredits(reservationOwnerId, requiredCredits', REFUND],
    ['incrementCredits(ownerId, amount', REFUND],
    ['incrementCredits(this.reservedCreditsOwnerId, delta', SETTLEMENT],
    ['incrementCredits(ownerId, delta', SETTLEMENT],
    ['subtractCredits(', SETTLEMENT],
    ['subtractCredits(', SETTLEMENT],
  ],
  'b4m-core/services/src/llm/tools/base/recordToolOperationalUsage.ts': [['recordOperationalUsage(', VIA_TOOL_HOST]],
  'b4m-core/services/src/llm/tools/implementation/knowledgeBaseSearch/index.ts': [
    ['recordOperationalUsage(', VIA_TOOL_HOST],
  ],
  'b4m-core/services/src/userService/heldSignupGrants.ts': [
    ['decrementCreditsIfCovered(entry.userId, entry.credits', 'admin revocation of a signup grant, not metered spend'],
    ['incrementCredits(entry.userId, entry.credits', 'rollback of that revocation (adds credits)'],
  ],
  'packages/database/src/models/ai/AgentModel.ts': [['$inc: { currentCredits: credits }', HELPER]],
  'packages/database/src/models/auth/UserModel.ts': [
    ['$inc: { currentCredits: credits }', HELPER],
    ['$inc: { currentCredits: -credits }', HELPER],
  ],
  'packages/database/src/models/infra/admin/OrganizationModel.ts': [['$inc: { currentCredits: amount }', HELPER]],
  'packages/scripts/src/auditPartialCreditPurchases.ts': [
    ['$inc: { currentCredits: row.credits }', 'one-off repair restoring purchased credits (adds credits)'],
  ],
  'packages/server-utils/src/billing/billedWebTools.ts': [
    ['reserveRequestCredits(', VIA_RESERVE],
    ['reserveRequestCredits(', VIA_RESERVE],
  ],
  'packages/server-utils/src/billing/imageCreditHolds.ts': [['holdCredits(', VIA_HOLD]],
  'packages/server-utils/src/billing/meterPlatformCompletion.ts': [
    ['assertOwnerHasCredits(', 'gated-by assertCanAfford own freeze check'],
    ['reserveRequestCredits(', VIA_RESERVE],
  ],
  'packages/server-utils/src/billing/reserveRequestCredits.ts': [
    ['holdCredits(', 'gated-by assertSpendNotFrozen at the top of reserveRequestCredits'],
  ],
  'packages/server-utils/src/decisions/runDecision.ts': [['reserveRequestCredits(', VIA_RESERVE]],
  'packages/server-utils/src/deepAgent/toolMaterializer.ts': [
    ['assertOwnerHasCredits(', 'gated-by assertSpendNotFrozen at the top of the media tool start'],
  ],
  'packages/server-utils/src/deepAgent/wakeMetering.ts': [
    ['assertOwnerHasCredits(', 'gated-by assertOwnerCanAfford at the top of the preflight'],
  ],
  'packages/server-utils/src/referrals/subscriptionReward.ts': [['subtractCredits(', CLAWBACK]],
  'packages/server-utils/src/s3/uploadModerationMeter.ts': [['recordOperationalUsage(', 'UNGATED - review']],
  'packages/server-utils/src/voice/settleVoiceHold.ts': [
    ['incrementCredits(args.userId, -args.reservedCredits', 'gated-by the voice top-up hold freeze check'],
    ['incrementCredits(payerId, refundedCredits', REFUND],
  ],
};

const FIX_HINT = 'gate the new site with assertSpendNotFrozen, or classify it in SITES';

// Only comments that open a line, so prose naming a call is not a call site.
function stripComments(source: string): string {
  return source
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
    .split('\n')
    .filter(line => !line.trimStart().startsWith('//'))
    .join('\n');
}

// git grep, not an fs walk: tracked sources only (no dist/, node_modules), across the monorepo.
function scanSites(): { site: string; rule: string }[] {
  const files = execFileSync(
    'git',
    [
      'grep',
      '-lwE',
      '-e',
      PREFILTER_WORDS.join('|'),
      '--',
      '*.ts',
      '*.tsx',
      ':!*.test.ts',
      ':!*.test.tsx',
      ':!**/__tests__/**',
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  )
    .split('\n')
    .filter(Boolean);
  return files.flatMap(path => {
    const source = stripComments(readFileSync(resolve(REPO_ROOT, path), 'utf8'));
    return Object.entries(RULES).flatMap(([rule, pattern]) =>
      [...source.matchAll(pattern)].map(match => ({ site: `${path} | ${match[0].replace(/\s+/g, ' ')}`, rule }))
    );
  });
}

// Multiset difference, so a second identical call in a listed file still counts as new.
function minus(from: string[], take: string[]): string[] {
  const left = [...from];
  for (const item of take) {
    const i = left.indexOf(item);
    if (i !== -1) left.splice(i, 1);
  }
  return left.sort();
}

describe('spend-freeze classification of balance moves and reservations', () => {
  const scanned = scanSites();
  const found = scanned.map(({ site }) => site);
  const listed = Object.entries(SITES).flatMap(([path, calls]) => calls.map(([call]) => `${path} | ${call}`));

  it.each(Object.keys(RULES))('the %s scan finds sites (it is not vacuous)', rule => {
    expect(scanned.some(s => s.rule === rule)).toBe(true);
  });

  it('every site is classified against the spend freeze', () => {
    expect(minus(found, listed), FIX_HINT).toEqual([]);
  });

  it('every allow-list entry still has a site', () => {
    expect(minus(listed, found), 'drop the stale entry from SITES').toEqual([]);
  });
});
