import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Guard on how CI splits the apps/client unit suite across runners (#2015).
 *
 * The suite is over a thousand files and was the whole workflow's critical path, so it runs as N legs of
 * the `test-shards` matrix, each passing vitest's `--shard=i/N`. vitest slices a hash-sorted
 * list of resolved file paths, so for a COMPLETE set of legs the partition tiles the file set
 * exactly. The danger is the set not being complete: drop `--shard=3/3` and roughly a third of
 * the suite stops running, with every remaining leg green and no count anywhere to contradict
 * it. Duplicate a leg and those files run twice while another third never runs at all.
 *
 * Nothing else can catch that. The per-leg duration report would barely move, and the "Run
 * Tests" fan-in gate only checks that the legs it was given passed - not that they covered
 * everything. So the invariant gets pinned here: the indices present must be exactly 1..N with
 * no gaps and no repeats.
 *
 * Text-matched rather than YAML-parsed on purpose - the repo has no YAML parser dependency, and
 * a regex over the literal `--shard=i/N` strings is precisely the assertion wanted.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CI_WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml');

/**
 * Every shard leg declared as a matrix `args:` value, in file order.
 *
 * Anchored to the `args:` key rather than matching `--shard=` anywhere, because the workflow's
 * own comments quote the flag while explaining it. A looser regex counts that prose as a leg -
 * it did, on the first run of this guard - which both inflates the count and would let a comment
 * mentioning `--shard=3/3` satisfy the completeness check after the real leg was deleted.
 */
function readShardLegs(contents: string): Array<{ index: number; count: number }> {
  return [...contents.matchAll(/^\s*args:\s*'--shard=(\d+)\/(\d+)'\s*$/gm)].map(match => ({
    index: Number(match[1]),
    count: Number(match[2]),
  }));
}

describe('apps/client test-shard legs in ci.yml', () => {
  const contents = fs.readFileSync(CI_WORKFLOW, 'utf8');
  const legs = readShardLegs(contents);

  it('declares at least two legs (otherwise the flag is pointless overhead)', () => {
    expect(legs.length).toBeGreaterThanOrEqual(2);
  });

  it('agrees on a single leg count', () => {
    expect([...new Set(legs.map(leg => leg.count))]).toHaveLength(1);
  });

  it('covers every index exactly once, with no gaps and no duplicates', () => {
    // Explicit rather than letting `legs[0]` throw a bare TypeError: deleting every leg is a
    // plausible edit, and "no shard legs declared" is the message that explains it.
    expect(legs, 'no --shard legs declared in ci.yml').not.toHaveLength(0);
    const { count } = legs[0];
    const indices = legs.map(leg => leg.index).sort((a, b) => a - b);
    // The count in `i/N` IS the promise about how many legs exist, so it has to match how many
    // are actually declared - `--shard=1/3` and `--shard=2/3` alone is a silently missing third.
    expect(legs).toHaveLength(count);
    expect(indices).toEqual(Array.from({ length: count }, (_, i) => i + 1));
  });

  // `pnpm ... test -- --shard=1/3` forwards the literal `--` to vitest, which then reads the
  // rest as positional path filters: the shard is ignored and the leg runs the WHOLE suite, at
  // 3x the total cost, without erroring. Measured, not hypothetical. Pin the bare form.
  it('appends the shard args with no `--` separator', () => {
    const runLine = contents
      .split('\n')
      .find(line => line.includes('matrix.shard.script') && line.includes('matrix.shard.args'));
    expect(runLine, 'the sharded test command should reference matrix.shard.args').toBeDefined();
    expect(runLine).not.toMatch(/\s--\s/);
  });
});

describe('readShardLegs', () => {
  it('rejects a set with a missing index', () => {
    const legs = readShardLegs("  args: '--shard=1/3'\n  args: '--shard=2/3'\n");
    expect(legs).toHaveLength(2);
    expect(legs[0].count).toBe(3);
    // 2 declared against a promised 3 is the silent-drop shape this guard exists to fail on.
    expect(legs).not.toHaveLength(legs[0].count);
  });

  it('spots a duplicated index', () => {
    const legs = readShardLegs("  args: '--shard=1/3'\n  args: '--shard=2/3'\n  args: '--shard=2/3'\n");
    const indices = legs.map(leg => leg.index);
    expect(new Set(indices).size).not.toBe(indices.length);
  });

  it('spots legs disagreeing on the total', () => {
    const legs = readShardLegs("  args: '--shard=1/3'\n  args: '--shard=2/2'\n");
    expect([...new Set(legs.map(leg => leg.count))]).toHaveLength(2);
  });

  it('finds nothing when no legs are declared', () => {
    expect(readShardLegs('name: client\nfilter: --filter @bike4mind/client\n')).toEqual([]);
  });

  // The regression that produced this guard's own first red run: a comment quoting the flag is
  // prose, not a declared leg, and must not be counted as one.
  it('ignores the flag quoted inside a comment', () => {
    const legs = readShardLegs(
      ['          # `pnpm ... test -- --shard=1/3` silently ignores it.', "            args: '--shard=1/3'"].join('\n')
    );
    expect(legs).toEqual([{ index: 1, count: 3 }]);
  });
});
