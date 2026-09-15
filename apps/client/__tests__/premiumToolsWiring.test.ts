import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Wiring drift guard for premium overlay LLM tools.
 *
 * Premium tool implementations are NOT in b4mTools - they only reach the model
 * when a ChatCompletionProcess caller passes the generated `premiumLlmTools`
 * map as `externalTools`. A call site that forgets the merge does not fail
 * loudly: requested premium tools hit sharedToolBuilder's skip-with-warning
 * path and silently no-op (exactly how /api/opti slipped through when the
 * seam was introduced).
 *
 * This test statically walks apps/client for `new ChatCompletionProcess(`
 * call sites and asserts each file either references `premiumLlmTools` or is
 * explicitly allowlisted as an intentional omission with a justification.
 */

const CLIENT_ROOT = join(__dirname, '..');

/** Files allowed to construct ChatCompletionProcess without the merge. */
const INTENTIONAL_OMISSIONS = new Set<string>([
  // Admin harness with a hardcoded non-premium tool list; see comment at its
  // process() call.
  'pages/api/admin/rapid-reply/test.ts',
]);

const SCAN_DIRS = ['pages', 'server', 'app'];
const SKIP_DIRS = new Set(['node_modules', '.next', '.open-next', '.sst', '__tests__', 'premium-generated']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

describe('premium LLM tools wiring', () => {
  const callSites = SCAN_DIRS.flatMap(d => walk(join(CLIENT_ROOT, d)))
    .filter(f => readFileSync(f, 'utf8').includes('new ChatCompletionProcess('))
    .map(f => relative(CLIENT_ROOT, f));

  it('finds the known ChatCompletionProcess call sites (sanity)', () => {
    // If this drops to zero the scan itself broke (renamed class, moved dirs).
    expect(callSites.length).toBeGreaterThanOrEqual(5);
  });

  it.each(callSites)('%s passes premiumLlmTools to externalTools or is allowlisted', file => {
    const content = readFileSync(join(CLIENT_ROOT, file), 'utf8');
    const wired = content.includes('premiumLlmTools');
    const allowlisted = INTENTIONAL_OMISSIONS.has(file);
    expect(
      wired || allowlisted,
      `${file} constructs ChatCompletionProcess but neither references premiumLlmTools nor is allowlisted in INTENTIONAL_OMISSIONS`
    ).toBe(true);
  });

  it('keeps the allowlist free of stale entries', () => {
    for (const entry of INTENTIONAL_OMISSIONS) {
      expect(callSites, `allowlist entry ${entry} no longer constructs ChatCompletionProcess`).toContain(entry);
    }
  });
});
