import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Guards `outputFileTracingIncludes` in apps/client/next.config.mjs, which carries two unrelated
 * concerns that both fail SILENTLY when lost.
 *
 * The help half is the reason this file exists. Both server readers of the help content roots
 * (`pages/api/help/content.ts`, `server/help/retrieval.ts`) build their read paths by template
 * interpolation so that no root ever reaches a `path.*` call - deliberately, because @vercel/nft
 * cannot fold a `path.resolve()` whose base it does not know and falls back to globbing the whole
 * app directory into the bundle (measured at 47 MB against Lambda's hard 250 MB ceiling). The
 * cost of that choice is that nothing traces the two content directories implicitly any more, so
 * the declaration here is the only thing putting them in the deployed Lambda. Delete it and
 * `next build`, typecheck and every CI leg stay green while help content 404s at runtime, because
 * `loadHelpContent` swallows the ENOENT. No ordinary test can see it.
 *
 * The sandbox half is pinned in the same place for a merge-safety reason rather than a tracing
 * one. Both groups were added to this one object literal independently, so a conflict here
 * presents as a same-hunk collision that invites picking a side - and either side alone is a
 * green build that is broken in production: drop the sandbox entries and every `code_execute`
 * route silently loses its native binary, drop the help entries and help content 404s. The
 * correct resolution is always the union, and asserting all five keys is what makes a
 * one-sided resolution loud instead of silent.
 *
 * Imported rather than text-matched, unlike checkClientTestShards.test.ts and its siblings: this
 * config is ESM and evaluating it is both cheap and strictly stronger, since it checks the
 * RESOLVED values. A text match would pass on `HELP_CONTENT_ROOTS = []`.
 */
const CONFIG_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../apps/client/next.config.mjs');

const PUBLIC_GLOB = './public/help-content/**/*';
const ADMIN_GLOB = './app/generated/help-content-admin/**/*';

/** The routes that read help content off disk at request time. Both need BOTH roots. */
const HELP_ROUTES = ['/api/help/content', '/api/help/chat'];

/** Every route that can construct a REPL sandbox; each needs the isolated-vm prebuild. */
const SANDBOX_ROUTES = ['/api/data-lakes/rlm-answer', '/api/deep-agent/spin', '/api/agents/[id]/missions'];

describe('outputFileTracingIncludes', () => {
  let includes: Record<string, string[]>;

  beforeAll(async () => {
    const config = await import(CONFIG_PATH);
    includes = config.default.outputFileTracingIncludes;
  });

  it('is declared at all', () => {
    expect(includes, 'next.config.mjs must declare outputFileTracingIncludes').toBeTruthy();
  });

  it.each(HELP_ROUTES)('declares both help content roots for %s', route => {
    const globs = includes[route];
    expect(globs, `${route} must be declared - it reads help content off disk at request time`).toBeTruthy();
    // Both roots, not either: the public root is read for every caller and the admin root for an
    // admin, and a route missing one 404s exactly the articles that root holds.
    expect(globs).toContain(PUBLIC_GLOB);
    expect(globs).toContain(ADMIN_GLOB);
  });

  it.each(SANDBOX_ROUTES)('still declares an isolated-vm prebuild for %s', route => {
    const globs = includes[route];
    expect(globs, `${route} must keep its prebuild entry - see the union note in next.config.mjs`).toBeTruthy();
    expect(globs.some(glob => glob.includes('isolated-vm'))).toBe(true);
  });
});
