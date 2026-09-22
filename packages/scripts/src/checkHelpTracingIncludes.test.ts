import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Guards `outputFileTracingIncludes` in apps/client/next.config.mjs, which carries three unrelated
 * concerns: the help content roots, the generated help search artifacts (see ARTIFACT_ROUTES
 * below) and the isolated-vm sandbox prebuild. Most of what it declares fails SILENTLY when lost.
 * The two exceptions are the public content root and help-index.json, both of which the container
 * build's check-standalone-tree.mjs requires; the admin root, help-embeddings.json and the
 * prebuild have no guard at all.
 *
 * The content roots are the reason this file exists. Both of their server readers
 * (`pages/api/help/content.ts`, `server/help/retrieval.ts`) build their read paths by template
 * interpolation so that no root ever reaches a `path.*` call - deliberately, because the file
 * tracer cannot fold a `path.resolve()` whose base it does not know and falls back to globbing the
 * whole app directory into the bundle (measured at 47 MB against Lambda's hard 250 MB ceiling).
 * The cost of that choice is that nothing traces the two content directories implicitly any more,
 * so the declaration here is the only thing putting them in the deployed Lambda. Drop the admin
 * root and `next build`, typecheck and every CI leg stay green while every admin article 404s at
 * runtime, because `loadHelpContent` swallows the ENOENT. No ordinary test can see it.
 *
 * The sandbox prebuild is pinned in the same place for a merge-safety reason rather than a tracing
 * one. The three groups were added to this one object literal independently, so a conflict here
 * presents as a same-hunk collision that invites picking a side - and one side alone can be a
 * green build that is broken in production: drop the sandbox entries and every `code_execute`
 * route silently loses its native binary, drop the content roots and help content 404s. Dropping
 * the search artifacts breaks nothing today (see ARTIFACT_ROUTES), which is precisely why a
 * one-sided resolution there would go unnoticed. The correct resolution is always the union, and
 * asserting all six keys is what makes a one-sided resolution loud instead of silent.
 *
 * Imported rather than text-matched, unlike checkClientTestShards.test.ts and its siblings: this
 * config is ESM and evaluating it is both cheap and strictly stronger, since it checks the
 * RESOLVED values. A text match would pass on `HELP_CONTENT_ROOTS = []`.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CONFIG_PATH = path.join(REPO_ROOT, 'apps/client/next.config.mjs');

const PUBLIC_GLOB = './public/help-content/**/*';
const ADMIN_GLOB = './app/generated/help-content-admin/**/*';

const INDEX_ENTRY = './app/generated/help-index.json';
const EMBEDDINGS_ENTRY = './app/generated/help-embeddings.json';

/** The routes that read help content off disk at request time. Both need BOTH roots. */
const HELP_ROUTES = ['/api/help/content', '/api/help/chat'];

/**
 * The generated help artifacts, by the route that reads each. Unlike the content roots above,
 * these DO trace themselves: every read site is a path.join(process.cwd(), '<literal>'), which
 * the tracer folds to a concrete file. The declaration is what stops that being load-bearing -
 * it is a tracer implementation detail, not a documented contract, so an upgrade that stopped
 * folding it would take help-embeddings.json silently (nothing guards it) and help-index.json
 * only as far as the container build's check-standalone-tree.mjs.
 */
const ARTIFACT_ROUTES: ReadonlyArray<[route: string, entries: string[]]> = [
  ['/api/help', [INDEX_ENTRY]],
  ['/api/help/chat', [INDEX_ENTRY, EMBEDDINGS_ENTRY]],
];

/**
 * The read sites each route entry above was keyed to, so the declaration and its justification
 * cannot drift apart: move a read out of one of these modules and the entry it justifies goes
 * stale with nothing failing.
 *
 * A tripwire, not a proof. It matches one exact call shape - `process.cwd()` then the
 * single-quoted literal - so it stays green on a brand new reader in a third module, and on a
 * comment that happens to reproduce that whole token sequence. It goes RED on refactors that are
 * fine in themselves: hoisting the literal to a shared const, double quotes, a template literal,
 * or moving the join behind a helper. Each of those is a one-line fix here, which is the trade -
 * a loud local failure in exchange for catching the silent kind.
 */
const ARTIFACT_READERS: ReadonlyArray<[file: string, literal: string]> = [
  ['apps/client/pages/api/help/index.ts', 'app/generated/help-index.json'],
  ['apps/client/server/help/retrieval.ts', 'app/generated/help-index.json'],
  ['apps/client/server/help/retrieval.ts', 'app/generated/help-embeddings.json'],
];

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

  it.each(ARTIFACT_ROUTES)('declares the generated help artifacts it reads for %s', (route, entries) => {
    const globs = includes[route];
    expect(globs, `${route} must be declared - it reads a generated help artifact at request time`).toBeTruthy();
    for (const entry of entries) expect(globs).toContain(entry);
  });

  it.each(ARTIFACT_READERS)('%s still reads %s, so its declaration is not rotting', (file, literal) => {
    const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
    // The call shape, not the bare path: a whole-file match on the path alone stays green when the
    // read moves out of the module and only a comment naming the old file is left behind. `\s*`
    // absorbs a re-wrapped argument list. Asserted as a boolean because the haystack is a whole
    // source file, and a string matcher would print all of it as the received value on failure.
    const readSite = new RegExp(`process\\.cwd\\(\\),\\s*'${literal.replace(/\./g, '\\.')}'`);
    expect(
      readSite.test(source),
      `${file} no longer reads ${literal} off process.cwd(); the entry in next.config.mjs is now stale`
    ).toBe(true);
  });

  it.each(SANDBOX_ROUTES)('still declares an isolated-vm prebuild for %s', route => {
    const globs = includes[route];
    expect(globs, `${route} must keep its prebuild entry - see the union note in next.config.mjs`).toBeTruthy();
    expect(globs.some(glob => glob.includes('isolated-vm'))).toBe(true);
  });
});
