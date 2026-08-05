import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Wiring drift guard for `session.systemPromptId` resolution.
 *
 * `ChatCompletionProcess` only resolves a session's registry prompt when its options carry
 * `loadSystemPromptById`; with the key absent it silently falls through to `undefined` and the
 * session gets no authored prompt. That is invisible at runtime, and the route has already
 * suppressed the generic brand identity by then - so the session ends up with neither.
 *
 * This is not hypothetical. The resolver first shipped as an inline lambda inside
 * `chatCompletionDefaults`, which meant only the routes that spread THAT factory had it. Every
 * `/api/ai/llm` quest is handed to the always-on ChatCompletion worker, whose `getStaticOptions()`
 * is a separate hand-maintained object - so the feature was inert on the path the SPA actually uses
 * while looking correct in review. Same shape as the premium-tools seam that
 * `premiumToolsWiring.test.ts` guards, and the same reason: a capability wired per-factory is a
 * capability that silently isn't.
 *
 * A file passes if it references `loadSystemPromptById` directly, or spreads
 * `getDefaultChatCompletionOptions()` (which supplies it), or is explicitly allowlisted.
 */

const CLIENT_ROOT = join(__dirname, '..');

/** Construction sites intentionally allowed to omit the resolver, with justification. */
const INTENTIONAL_OMISSIONS = new Set<string>([]);

const SCAN_DIRS = ['pages', 'server'];
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

describe('session systemPromptId resolver wiring', () => {
  const callSites = SCAN_DIRS.flatMap(d => walk(join(CLIENT_ROOT, d)))
    .filter(f => readFileSync(f, 'utf8').includes('new ChatCompletionProcess('))
    .map(f => relative(CLIENT_ROOT, f));

  it('finds the known ChatCompletionProcess call sites (sanity)', () => {
    // If this drops to zero the scan itself broke (renamed class, moved dirs) and every
    // assertion below would vacuously pass.
    expect(callSites.length).toBeGreaterThanOrEqual(5);
  });

  it.each(callSites)('%s supplies loadSystemPromptById or is allowlisted', file => {
    const content = readFileSync(join(CLIENT_ROOT, file), 'utf8');
    const wired =
      content.includes('loadSystemPromptById') || content.includes('getDefaultChatCompletionOptions');
    expect(
      wired || INTENTIONAL_OMISSIONS.has(file),
      `${file} constructs ChatCompletionProcess but neither supplies loadSystemPromptById nor spreads ` +
        `getDefaultChatCompletionOptions. A session with systemPromptId set would silently get no ` +
        `authored prompt here. Wire it, or allowlist with a justification.`
    ).toBe(true);
  });

  it('keeps the allowlist free of stale entries', () => {
    for (const entry of INTENTIONAL_OMISSIONS) {
      expect(callSites, `allowlist entry ${entry} no longer constructs ChatCompletionProcess`).toContain(entry);
    }
  });

  it('resolves the id through exactly one shared implementation', () => {
    // The bug this guards against was one factory having its own copy. If a second inline
    // implementation appears, the guard above would still pass while the copies drift.
    const implementations = SCAN_DIRS.flatMap(d => walk(join(CLIENT_ROOT, d))).filter(f =>
      /loadSystemPromptById\s*(:|=)\s*async/.test(readFileSync(f, 'utf8'))
    );
    expect(
      implementations.map(f => relative(CLIENT_ROOT, f)),
      'loadSystemPromptById should be defined once, in server/utils/sessionSystemPromptResolver.ts'
    ).toEqual(['server/utils/sessionSystemPromptResolver.ts']);
  });
});
