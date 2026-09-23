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
 * Every shard leg declared as a matrix `args:` value, in file order, tagged with the lane its own
 * matrix block selects.
 *
 * Block-scoped on purpose. The workflow runs TWO shard sets over the same package - the unit `test`
 * lane and the `test:integration` lane - so a leg's `args` only promises anything about the lane of
 * the `script` in the SAME block. Collecting every `--shard=i/N` in the file and asserting one
 * complete set would see six legs of `i/3` and fail; grouping them globally would be worse, since a
 * lane that had lost a leg would pass as long as the other lane still covered 1..N.
 *
 * A block runs from one `- name:` to the next. The `args:` key is anchored inside it rather than
 * matched anywhere in the file, because the workflow's own comments quote the flag while explaining
 * it - a looser regex counted that prose as a leg on this guard's first run.
 */
function readShardLegs(contents: string): Array<{ index: number; count: number; lane: string }> {
  const blocks = contents.split(/^\s*- name:/m).slice(1);
  const legs: Array<{ index: number; count: number; lane: string }> = [];

  for (const block of blocks) {
    const args = /^\s*args:\s*'--shard=(\d+)\/(\d+)'\s*$/m.exec(block);
    if (!args) continue;
    // An unset `script` means the unit lane: the step resolves `matrix.shard.script || 'test'`.
    const script = /^\s*script:\s*'([^']+)'\s*$/m.exec(block);
    legs.push({ index: Number(args[1]), count: Number(args[2]), lane: script ? script[1] : 'test' });
  }

  return legs;
}

/**
 * Every leg's matrix `filter:` value, in file order, as YAML hands it to the runner - so the
 * outer quote pair, which belongs to the YAML parser, is stripped here too.
 *
 * The step passes this value to pnpm by splitting it on whitespace into argv. Nothing in that
 * path processes quotes, so a quote character left INSIDE the value is a character in the
 * argument pnpm receives: it looks for a package literally named `'!@bike4mind/client'`, finds
 * none, prints "No projects matched the filters" and exits 0. Zero tests run and the leg is
 * green, which is why the assertion below pins bare tokens.
 */
function readShardFilters(contents: string): string[] {
  return [...contents.matchAll(/^\s*filter:\s*(\S.*?)\s*$/gm)].map(match => {
    const raw = match[1];
    const unquoted = /^'(.*)'$/.exec(raw) ?? /^"(.*)"$/.exec(raw);
    return unquoted ? unquoted[1] : raw;
  });
}

describe('apps/client test-shard legs in ci.yml', () => {
  const contents = fs.readFileSync(CI_WORKFLOW, 'utf8');
  const legs = readShardLegs(contents);
  const lanes = new Map<string, Array<{ index: number; count: number; lane: string }>>();
  for (const leg of legs) lanes.set(leg.lane, [...(lanes.get(leg.lane) ?? []), leg]);

  it('declares both the unit and the integration lane', () => {
    // Each lane is asserted complete below, so a lane that vanished entirely - or a `script` typo
    // that merged two lanes into one group - has to be caught here. Otherwise it just shrinks the
    // set of things checked, the same silent-drop shape this whole file exists to prevent.
    expect([...lanes.keys()].sort()).toEqual(['test', 'test:integration']);
  });

  it('declares at least two legs per lane (otherwise the flag is pointless overhead)', () => {
    for (const [lane, laneLegs] of lanes) {
      expect(laneLegs.length, `lane ${lane} legs`).toBeGreaterThanOrEqual(2);
    }
  });

  it('agrees on a single leg count per lane', () => {
    for (const [lane, laneLegs] of lanes) {
      expect([...new Set(laneLegs.map(leg => leg.count))], `lane ${lane} leg counts`).toHaveLength(1);
    }
  });

  it('covers every index exactly once per lane, with no gaps and no duplicates', () => {
    for (const [lane, laneLegs] of lanes) {
      // Explicit rather than letting `laneLegs[0]` throw a bare TypeError: deleting every leg of
      // one lane is a plausible edit, and "no shard legs declared" is the message that explains it.
      expect(laneLegs, `no --shard legs declared for lane ${lane}`).not.toHaveLength(0);
      const { count } = laneLegs[0];
      const indices = laneLegs.map(leg => leg.index).sort((a, b) => a - b);
      // The count in `i/N` IS the promise about how many legs that lane has, so it has to match
      // how many are actually declared - `--shard=1/3` and `--shard=2/3` alone is a missing third.
      expect(laneLegs, `lane ${lane} leg count matches its i/N`).toHaveLength(count);
      expect(indices, `lane ${lane} indices`).toEqual(Array.from({ length: count }, (_, i) => i + 1));
    }
  });

  // `pnpm ... test -- --shard=1/3` forwards the literal `--` to vitest, which then reads the
  // rest as positional path filters: the shard is ignored and the leg runs the WHOLE suite, at
  // 3x the total cost, without erroring. Measured, not hypothetical. Pin the bare form.
  //
  // The matrix value no longer reaches the command by `${{ }}` interpolation; it goes through
  // an `env:` entry and a bash array. So walk that chain rather than assuming any link in it:
  // matrix.shard.args -> SHARD_ARGS -> the array the step splits it into -> the pnpm argv. A
  // guard that only matched a fixed name would pass vacuously the next time the shape moves,
  // which is exactly how this assertion went stale before.
  it('appends the shard args with no `--` separator', () => {
    expect(contents, 'SHARD_ARGS should carry matrix.shard.args into the step').toMatch(
      /^\s*SHARD_ARGS:\s*\$\{\{\s*matrix\.shard\.args\s*\}\}\s*$/m
    );
    const binding = /read\s+-ra\s+(\w+)\s*<<<\s*"\$SHARD_ARGS"/.exec(contents);
    expect(binding, 'the step should split SHARD_ARGS into an argv array').not.toBeNull();
    const argsArray = binding![1];
    const runLine = contents.split('\n').find(line => /\bpnpm\b/.test(line) && line.includes(`\${${argsArray}[@]}`));
    expect(runLine, `the sharded test command should pass ${argsArray} to pnpm`).toBeDefined();
    expect(runLine).not.toMatch(/\s--\s/);
  });

  // The other half of the same env hop. Word splitting is what turns one env var back into
  // several arguments, and it does not strip quotes - so a quoted token here silently matches
  // no package rather than erroring. Pin bare `--filter <pattern>` pairs.
  it('declares every leg filter as bare `--filter <pattern>` pairs', () => {
    const filters = readShardFilters(contents);
    expect(filters, 'no shard filters declared in ci.yml').not.toHaveLength(0);
    for (const filter of filters) {
      expect(filter, `quote character inside a shard filter: ${filter}`).not.toMatch(/['"]/);
      const tokens = filter.split(/\s+/);
      expect(tokens.length % 2, `unpaired --filter in: ${filter}`).toBe(0);
      for (let i = 0; i < tokens.length; i += 2) {
        expect(tokens[i], `expected --filter at token ${i} of: ${filter}`).toBe('--filter');
        // `!` prefix is pnpm's exclusion form; the catch-all leg is built entirely from those.
        expect(tokens[i + 1], `not a workspace package pattern: ${tokens[i + 1]}`).toMatch(
          /^!?@bike4mind\/[a-z0-9-]+$/
        );
      }
    }
  });
});

describe('readShardLegs', () => {
  const leg = (index: number, count: number, lane = 'test') => ({ index, count, lane });
  const unitLeg = (index: number, count: number) =>
    [`          - name: client ${index}/${count}`, `            args: '--shard=${index}/${count}'`].join('\n');
  const integrationLeg = (index: number, count: number) =>
    [
      `          - name: client-integration ${index}/${count}`,
      "            script: 'test:integration'",
      `            args: '--shard=${index}/${count}'`,
    ].join('\n');

  it("reads each leg's lane from its own matrix block", () => {
    const legs = readShardLegs([unitLeg(1, 3), integrationLeg(1, 3)].join('\n'));
    expect(legs).toEqual([leg(1, 3), leg(1, 3, 'test:integration')]);
  });

  it('keeps `script` scoped to its own block', () => {
    // The integration lane's `script` must not leak onto the unit leg that follows it.
    const legs = readShardLegs([integrationLeg(1, 3), unitLeg(1, 3)].join('\n'));
    expect(legs).toEqual([leg(1, 3, 'test:integration'), leg(1, 3)]);
  });

  it('attributes legs per lane, so a lane missing an index cannot hide behind a complete one', () => {
    const legs = readShardLegs(
      [
        unitLeg(1, 3),
        unitLeg(2, 3),
        unitLeg(3, 3),
        integrationLeg(1, 3),
        // integration 2/3 is dropped: the unit lane stays complete and must not mask it.
        integrationLeg(3, 3),
      ].join('\n')
    );
    const integration = legs
      .filter(candidate => candidate.lane === 'test:integration')
      .map(candidate => candidate.index)
      .sort((a, b) => a - b);
    expect(integration).toEqual([1, 3]);
    expect(integration).not.toEqual([1, 2, 3]);
  });

  it('rejects a set with a missing index', () => {
    const legs = readShardLegs([unitLeg(1, 3), unitLeg(2, 3)].join('\n'));
    expect(legs).toHaveLength(2);
    expect(legs[0].count).toBe(3);
    // 2 declared against a promised 3 is the silent-drop shape this guard exists to fail on.
    expect(legs).not.toHaveLength(legs[0].count);
  });

  it('spots a duplicated index', () => {
    const legs = readShardLegs([unitLeg(1, 3), unitLeg(2, 3), unitLeg(2, 3)].join('\n'));
    const indices = legs.map(candidate => candidate.index);
    expect(new Set(indices).size).not.toBe(indices.length);
  });

  it('spots legs disagreeing on the total', () => {
    const legs = readShardLegs([unitLeg(1, 3), unitLeg(2, 2)].join('\n'));
    expect([...new Set(legs.map(candidate => candidate.count))]).toHaveLength(2);
  });

  it('finds nothing when no legs are declared', () => {
    expect(readShardLegs('name: client\nfilter: --filter @bike4mind/client\n')).toEqual([]);
  });

  // The regression that produced this guard's own first red run: a comment quoting the flag is
  // prose, not a declared leg, and must not be counted as one.
  it('ignores the flag quoted inside a comment', () => {
    const legs = readShardLegs(
      [
        '          - name: client 1/3',
        '            # `pnpm ... test -- --shard=1/3` silently ignores it.',
        "            args: '--shard=1/3'",
      ].join('\n')
    );
    expect(legs).toEqual([leg(1, 3)]);
  });
});

describe('readShardFilters', () => {
  it('strips the YAML quote pair, which belongs to the parser and not to bash', () => {
    expect(readShardFilters("            filter: '--filter @bike4mind/client'\n")).toEqual([
      '--filter @bike4mind/client',
    ]);
    expect(readShardFilters('            filter: "--filter @bike4mind/client"\n')).toEqual([
      '--filter @bike4mind/client',
    ]);
  });

  it('keeps quotes that are inside the value', () => {
    // The exact shape that made a leg match nothing: YAML strips only the outer double quotes,
    // so pnpm is handed `'!@bike4mind/client'` with the single quotes still attached.
    expect(readShardFilters('            filter: "--filter \'!@bike4mind/client\'"\n')).toEqual([
      "--filter '!@bike4mind/client'",
    ]);
  });

  it('reads an unquoted value as-is', () => {
    expect(readShardFilters('            filter: --filter @bike4mind/client\n')).toEqual([
      '--filter @bike4mind/client',
    ]);
  });

  it('finds every leg, in file order', () => {
    const contents = [
      '          - name: services',
      "            filter: '--filter @bike4mind/services'",
      '          - name: misc',
      "            filter: '--filter !@bike4mind/services'",
    ].join('\n');
    expect(readShardFilters(contents)).toEqual(['--filter @bike4mind/services', '--filter !@bike4mind/services']);
  });

  it('finds nothing when no filters are declared', () => {
    expect(readShardFilters("name: client\nargs: '--shard=1/3'\n")).toEqual([]);
  });
});
