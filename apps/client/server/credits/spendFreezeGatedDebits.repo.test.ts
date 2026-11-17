// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../../..');

// Raw debits and direct credit pre-checks sit outside CreditHoldAdapters, so the type system does not
// force a spend-freeze decision on them. Each site lives here with where its freeze check runs.
const NEGATIVE_DEBIT = /\bincrementCredits\(\s*[^,()]+,\s*-/;
const OWNER_CREDIT_PRECHECK = /(?<!function )\bassertOwnerHasCredits\(/;

const NEGATIVE_DEBIT_SITES: Record<string, string> = {
  'b4m-core/services/src/cliCompletions.ts': 'gated-by assertSpendNotFrozen ahead of the reservation',
  'b4m-core/services/src/creditService/creditHold.ts': 'gated-by holdCredits own assertSpendNotFrozen',
  'b4m-core/services/src/llm/ChatCompletionProcess.ts': 'gated-by the chat turn freeze check before the hold',
  'packages/server-utils/src/voice/settleVoiceHold.ts': 'gated-by the voice top-up hold freeze check',
  'b4m-core/services/src/creditService/subtractCredits.ts': 'settlement',
  'apps/client/server/websocket/voiceSessionEnded.ts': 'settlement',
};

const OWNER_CREDIT_PRECHECK_SITES: Record<string, string> = {
  'apps/client/pages/api/v1/sessions/semantic-search.ts': 'gated-by assertSpendNotFrozen earlier in the route',
  'apps/client/server/chatCompletion/external/embedRoute.ts': 'gated-by assertSpendNotFrozen earlier in the route',
  'packages/server-utils/src/billing/meterPlatformCompletion.ts': 'gated-by assertCanAfford own freeze check',
  'packages/server-utils/src/deepAgent/wakeMetering.ts': 'gated-by assertOwnerCanAfford at the top of the preflight',
};

const FIX_HINT = 'gate the new site with assertSpendNotFrozen, or classify it in this allow-list';

// Only comments that open a line, so prose naming a call is not a call site.
function stripComments(source: string): string {
  return source
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
    .split('\n')
    .filter(line => !line.trimStart().startsWith('//'))
    .join('\n');
}

// git grep, not an fs walk: tracked sources only (no dist/, node_modules), across the monorepo.
function filesMatching(pattern: RegExp, word: string): string[] {
  const out = execFileSync(
    'git',
    ['grep', '-lw', word, '--', '*.ts', '*.tsx', ':!*.test.ts', ':!*.test.tsx', ':!**/__tests__/**'],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  );
  return out
    .split('\n')
    .filter(Boolean)
    .filter(path => pattern.test(stripComments(readFileSync(resolve(REPO_ROOT, path), 'utf8'))));
}

describe.each([
  { kind: 'negative incrementCredits', pattern: NEGATIVE_DEBIT, word: 'incrementCredits', sites: NEGATIVE_DEBIT_SITES },
  {
    kind: 'assertOwnerHasCredits',
    pattern: OWNER_CREDIT_PRECHECK,
    word: 'assertOwnerHasCredits',
    sites: OWNER_CREDIT_PRECHECK_SITES,
  },
])('$kind call sites', ({ pattern, word, sites }) => {
  const scanned = filesMatching(pattern, word);

  it('finds the known sites (the scan is not vacuous)', () => {
    expect(scanned.length).toBeGreaterThan(1);
  });

  it('every site is classified against the spend freeze', () => {
    const unlisted = scanned.filter(path => !(path in sites));
    expect(unlisted, FIX_HINT).toEqual([]);
  });

  it.each(Object.keys(sites))('allow-list entry %s still has a site', path => {
    expect(existsSync(resolve(REPO_ROOT, path)), `${path} no longer exists; drop it from the allow-list`).toBe(true);
    expect(scanned, `${path} no longer has this call; drop it from the allow-list`).toContain(path);
  });
});
