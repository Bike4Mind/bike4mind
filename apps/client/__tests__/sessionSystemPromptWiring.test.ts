import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Wiring drift guard for `session.systemPromptId` resolution.
 *
 * `ChatCompletionProcess` only resolves a session's registry prompt when its options carry
 * `loadSystemPromptById`; with the key absent it falls through to `undefined` and the session gets
 * no authored prompt, while the route has already suppressed the generic brand identity by then -
 * so the session ends up with neither, silently.
 *
 * Not hypothetical: the resolver first shipped as an inline lambda inside `chatCompletionDefaults`,
 * so only routes spreading THAT factory had it. Every `/api/ai/llm` quest goes to the always-on
 * ChatCompletion worker, whose `getStaticOptions()` is a separate hand-maintained object - the
 * feature was inert on the path the SPA actually uses while looking correct in review.
 *
 * WHAT THIS CATCHES, stated precisely because an earlier version of this file overclaimed and a
 * docstring elsewhere cites it as proof of non-recurrence:
 *   - a construction site whose options object omits the key (the original bug), because the
 *     per-site check requires the PROPERTY, not a mention of the identifier anywhere in the file.
 *     A bare import, a reference inside a comment, or a helper that merely calls the resolver do
 *     NOT satisfy it.
 *   - a second implementation of the resolver appearing anywhere in the scanned tree, in any
 *     declaration form, so a rogue copy that skips the allowlist cannot quietly coexist.
 *
 * WHAT IT DOES NOT CATCH - do not read a green run as proof of correct wiring:
 *   - construction outside `apps/client/pages` and `apps/client/server` (e.g. `b4m-core`,
 *     `packages/cli`), or inside `premium-generated`, which overlays hydrate and which is skipped.
 *   - a site that aliases the import (`ChatCompletionProcess as CCP`), subclasses it, or builds it
 *     through a wrapper, since the scan matches the literal `new ChatCompletionProcess(`.
 *   - whether the resolver, once passed, actually returns anything useful at runtime.
 *
 * `premiumToolsWiring.test.ts` guards the same class of defect for premium tools and still uses a
 * whole-file substring check, so it has the first weakness this file just fixed. Worth aligning.
 */

const CLIENT_ROOT = join(__dirname, '..');

/**
 * Construction sites intentionally allowed to omit the resolver. An entry here silently restores
 * the original bug for that file, so it needs a written justification next to it.
 */
const INTENTIONAL_OMISSIONS = new Set<string>([]);

const SCAN_DIRS = ['pages', 'server'];
const SKIP_DIRS = new Set(['node_modules', '.next', '.open-next', '.sst', '__tests__', 'premium-generated']);

/** The key as an object PROPERTY - shorthand (`loadSystemPromptById,`) or explicit (`x: fn`). */
const SUPPLIES_PROPERTY = /^\s*loadSystemPromptById\s*[,:]/m;
/** Inheriting it by spreading the shared factory is equally valid wiring. */
const SPREADS_FACTORY = /\.\.\.\s*getDefaultChatCompletionOptions\s*\(/;
/** Any declaration form, so a reformat of the canonical resolver is not a false alarm. */
const DEFINES_RESOLVER = /export\s+(?:const|(?:async\s+)?function)\s+loadSystemPromptById\b/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), out);
    } else if (/\.(tsx?|mjs|js)$/.test(entry.name) && !/\.test\.(tsx?|js)$/.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

describe('session systemPromptId resolver wiring', () => {
  const scanned = SCAN_DIRS.flatMap(d => walk(join(CLIENT_ROOT, d)));
  const callSites = scanned
    .filter(f => readFileSync(f, 'utf8').includes('new ChatCompletionProcess('))
    .map(f => relative(CLIENT_ROOT, f));

  it('the scan itself works (guards against every assertion below passing vacuously)', () => {
    // Deliberately NOT a specific count: consolidating the five factories into one shared builder
    // would be an improvement that reduces it, and a guard that punishes the fix is a guard that
    // gets deleted. This only asserts the walk found files and at least one construction site.
    expect(scanned.length).toBeGreaterThan(50);
    expect(callSites.length).toBeGreaterThan(0);
  });

  it.each(callSites)('%s supplies loadSystemPromptById as an option or is allowlisted', file => {
    const content = readFileSync(join(CLIENT_ROOT, file), 'utf8');
    const wired = SUPPLIES_PROPERTY.test(content) || SPREADS_FACTORY.test(content);
    expect(
      wired || INTENTIONAL_OMISSIONS.has(file),
      `${file} constructs ChatCompletionProcess but does not pass loadSystemPromptById as an ` +
        `options property, nor spread getDefaultChatCompletionOptions(). A session with ` +
        `systemPromptId set would silently get no authored prompt here. Note an import or a ` +
        `mention of the name is deliberately NOT enough - the key must be in the options object.`
    ).toBe(true);
  });

  it('keeps the allowlist free of stale entries', () => {
    // Vacuous while the allowlist is empty, which is the intended steady state; it exists so an
    // entry cannot outlive the call site it was added for.
    for (const entry of INTENTIONAL_OMISSIONS) {
      expect(callSites, `allowlist entry ${entry} no longer constructs ChatCompletionProcess`).toContain(entry);
    }
  });

  it('resolves the id through exactly one shared implementation', () => {
    // The original bug was one factory owning its own copy. Matching any export form (const,
    // function, async function) so a behaviour-preserving reformat of the canonical resolver does
    // not fail this, while a genuine second definition - including one that skips the allowlist
    // check - does.
    const implementations = scanned
      .filter(f => DEFINES_RESOLVER.test(readFileSync(f, 'utf8')))
      .map(f => relative(CLIENT_ROOT, f));
    expect(
      implementations,
      'loadSystemPromptById must be defined exactly once, in server/utils/sessionSystemPromptResolver.ts'
    ).toEqual(['server/utils/sessionSystemPromptResolver.ts']);
  });
});
