import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Pins the three things that keep the Next server Lambda under its unzipped size cap.
 *
 * None of them can be protected by an ordinary unit test. The tracing regression that started
 * this produced byte-identical runtime behaviour - every existing test passed on the swept
 * build and on the fixed one - and the only difference was in `next build`'s traced file set,
 * which no unit test can see. So each invariant is pinned at its declaration site instead:
 * a revert has to edit one of these literals, and editing it fails here.
 *
 * Text-matched rather than executed, deliberately. Executing the real thing means a full
 * `next build`, which does not belong in a unit shard; the shapes below are what the build
 * reads, so pinning them is the same assertion at a thousandth of the cost.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

/** Comments here explain the banned shapes by name, so the ban has to be read against code only. */
const codeOnly = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('spoolRequestToFile keeps its temp path opaque to the file tracer', () => {
  /**
   * Measured, not theorised: with the join() here the build traced all of apps/client into the
   * bundle, and with the interpolation it does not. The mechanism is the inferred part - the
   * tracer looks unable to fold a join() chained onto a value known only at runtime (mkdtemp's
   * return) and appears to fall back to globbing the containing directory - and a standalone
   * nodeFileTrace over the same shape did not reproduce it, so treat the shape as the trigger
   * and the explanation as provisional.
   *
   * Scoped to this one module on purpose. The broad shape - any join() the tracer cannot fold -
   * matches roughly twenty other sites in traced server code that demonstrably do not sweep, so
   * a repo-wide ban would be noise. This is the site where the difference was measured.
   */
  const source = read('apps/client/server/utils/spoolRequestToFile.ts');

  it('builds the spooled path by interpolation, not by joining onto the mkdtemp result', () => {
    expect(source).toMatch(/const dir = await mkdtemp\(/);
    expect(source, 'the spooled path must be a template literal off the mkdtemp result').toMatch(
      /const path = `\$\{dir\}\//
    );
  });

  it('calls no path-building helper the tracer would have to fold', () => {
    const code = codeOnly(source);
    expect(code, 'this module must build no path at all, so the tracer never has a call to fold').not.toMatch(
      /\bjoin\s*\(/
    );
    expect(
      code,
      'the ban is scoped to this one small file, so a Promise resolve() here is a finding too, not a false positive'
    ).not.toMatch(/\bresolve\s*\(/);
  });

  it('still sanitises the caller-supplied filename', () => {
    expect(source).toMatch(/basename\(options\.filename/);
  });
});

describe('the container build asserts its output after pruning it', () => {
  it('prunes compiled test routes and only then checks what it is about to copy', () => {
    const dockerfile = read('Dockerfile');
    const pruneAt = dockerfile.indexOf('pruneTestRoutes.mjs');
    const guardAt = dockerfile.indexOf('check-standalone-tree.mjs');
    expect(pruneAt, 'Dockerfile must still prune compiled test routes').toBeGreaterThan(-1);
    expect(guardAt, 'Dockerfile must check the standalone tree').toBeGreaterThan(-1);
    expect(guardAt, 'the tree check has to run after the prune to describe what ships').toBeGreaterThan(pruneAt);
  });
});

/**
 * The excludes themselves are dormant - Next applies them in collect-build-traces, which it
 * skips under Turbopack - so what is worth pinning is the carve-out, not the effect. Someone
 * trimming the bundle later will reach for public/** first, and it is the one directory here
 * that is read at request time.
 */
describe('outputFileTracingExcludes floor', () => {
  const config = read('apps/client/next.config.mjs');

  it('declares the Playwright suite and unit tests as excludable', () => {
    expect(config).toMatch(/outputFileTracingExcludes/);
    expect(config).toMatch(/'e2e\/\*\*'/);
    expect(config).toMatch(/'\*\*\/\*\.test\.ts\?\(x\)'/);
  });

  it('does not exclude public/**, which the help retrieval path reads at request time', () => {
    // server/help/retrieval.ts resolves public/help-content per request, so excluding public/**
    // would trade a smaller bundle for a runtime ENOENT.
    const excludes = /outputFileTracingExcludes:\s*\{[\s\S]*?\n {2}\},/.exec(config);
    expect(excludes, 'outputFileTracingExcludes block not found').not.toBeNull();
    expect(excludes![0]).not.toContain('public');
    // The literal moved to its definition: retrieval.ts now imports PUBLIC_HELP_CONTENT_DIR and
    // interpolates it, deliberately, so that no root reaches a path.* call the tracer would try
    // to fold. Assert the constant's value where it is declared plus the import at the read site,
    // which is the same invariant this always meant - that something still reads that directory
    // at request time - without pinning a literal that is now in the wrong file.
    expect(read('packages/scripts/help/utils.ts')).toContain("PUBLIC_HELP_CONTENT_DIR = 'public/help-content'");
    expect(read('apps/client/server/help/retrieval.ts')).toContain('PUBLIC_HELP_CONTENT_DIR');
  });
});
