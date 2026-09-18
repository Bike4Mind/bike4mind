import { describe, expect, it } from 'vitest';
import {
  auditOwners,
  buildDrainMembershipQuery,
  checkExpectedPopulation,
  checkPlatformGuards,
  DEFAULT_WAVE,
  MAX_WAVE,
  parseDrainArgs,
  planWaves,
  resolveLakeId,
  tally,
  verifyVerdict,
  type DrainFileRow,
  type DrainTarget,
} from './drainLakeEmbeddingSpacePlan';

const LAKES = ['ionq-sales', 'opti-knowledge'];
const parse = (...argv: string[]) => parseDrainArgs({ argv, lakes: LAKES });

const dbTarget = (over: Partial<DrainTarget> = {}): DrainTarget => ({
  lakeIdKind: 'db',
  tag: 'datalake:test-lake',
  prefix: 'test:',
  owners: ['owner-1'],
  ...over,
});

const row = (over: Partial<DrainFileRow> = {}): DrainFileRow => ({ _id: 'f1', userId: 'owner-1', ...over });

describe('parseDrainArgs', () => {
  it('parses a dry run against a known lake', () => {
    const out = parse('--lake', 'ionq-sales');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value).toEqual({
      lake: 'ionq-sales',
      execute: false,
      verify: false,
      limit: undefined,
      expect: undefined,
      wave: DEFAULT_WAVE,
    });
  });

  it('prints usage and returns 1 with no --lake', () => {
    const out = parse('--execute');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.exitCode).toBe(1);
    expect(out.lines[0]).toContain('usage: --lake <ionq-sales|opti-knowledge>');
  });

  it('refuses an unknown lake rather than scoping to nothing', () => {
    const out = parse('--lake', 'some-other-lake', '--execute');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.exitCode).toBe(1);
  });

  it('refuses --lake followed by another flag, which parses as that flag name', () => {
    // The shape that would otherwise run unscoped against whatever "--execute" resolved to.
    const out = parse('--lake', '--execute');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.exitCode).toBe(1);
  });

  it('refuses --execute together with --verify instead of silently only reading', () => {
    const out = parse('--lake', 'ionq-sales', '--execute', '--verify', '--expect', '3');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.exitCode).toBe(1);
    expect(out.lines[0]).toMatch(/^STOP: --execute with --verify/);
  });

  it('clamps the wave to MAX_WAVE', () => {
    const out = parse('--lake', 'ionq-sales', '--wave', '10000');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.wave).toBe(MAX_WAVE);
  });

  it('refuses a non-numeric wave, which would otherwise enqueue nothing and report success', () => {
    // Number('abc') is NaN, so the first `i < length` test in the wave loop is false: no message is
    // ever sent and the run finishes clean. There is no output that distinguishes it from a drain
    // of an already-converged lake.
    const out = parse('--lake', 'ionq-sales', '--wave', 'abc');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.exitCode).toBe(1);
    expect(out.lines[0]).toContain('--wave');
  });

  it('refuses a zero wave, which never advances the loop at all', () => {
    const out = parse('--lake', 'ionq-sales', '--wave', '0');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.exitCode).toBe(1);
  });

  it('refuses a zero limit, which executes over nothing', () => {
    const out = parse('--lake', 'ionq-sales', '--execute', '--limit', '0');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.exitCode).toBe(1);
  });

  it('accepts --expect 0, because that is what the dry run prints for an empty population', () => {
    const out = parse('--lake', 'ionq-sales', '--execute', '--expect', '0');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.expect).toBe(0);
  });

  it('refuses a fractional count', () => {
    expect(parse('--lake', 'ionq-sales', '--wave', '2.5').ok).toBe(false);
  });

  it('falls back to the default wave when the flag is last and has no value', () => {
    const out = parse('--lake', 'ionq-sales', '--wave');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.wave).toBe(DEFAULT_WAVE);
  });
});

describe('checkPlatformGuards', () => {
  const clear = { defaultModel: 'text-embedding-3-small', paused: undefined, scopedSettingsRows: 0 };

  it('proceeds with the resolved default model', () => {
    const out = checkPlatformGuards(clear);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value).toBe('text-embedding-3-small');
  });

  it('refuses rather than guessing the target space when the setting has no row', () => {
    const out = checkPlatformGuards({ ...clear, defaultModel: '' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.exitCode).toBe(2);
    expect(out.lines[0]).toMatch(/^STOP: defaultEmbeddingModel has no row/);
  });

  it('refuses while convergence is paused, since the reset files would sit unsearchable', () => {
    const out = checkPlatformGuards({ ...clear, paused: true });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.exitCode).toBe(2);
    expect(out.lines[0]).toContain('PauseLakeConvergence');
  });

  it('treats a truthy non-boolean pause value as paused and reports it verbatim', () => {
    // An admin setting is stored as whatever was written into settingValue, so the string "true"
    // and the string "false" are both possible - and only one of them is truthy here.
    const out = checkPlatformGuards({ ...clear, paused: 'true' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.lines[0]).toContain('"true"');
  });

  it('refuses when any scopedsettings row exists, because the pause check reads platform only', () => {
    const out = checkPlatformGuards({ ...clear, scopedSettingsRows: 1 });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.exitCode).toBe(2);
    expect(out.lines[0]).toContain('scopedsettings');
  });
});

describe('resolveLakeId', () => {
  it('uses the slug for a registry lake', () => {
    const out = resolveLakeId({
      target: dbTarget({ lakeIdKind: 'registry', registryId: 'opti-knowledge' }),
      lakeRow: null,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value).toBe('opti-knowledge');
  });

  it('refuses a registry target with no registryId rather than enqueueing an empty lakeId', () => {
    // An empty lakeId is what a per-lake PauseLakeConvergence would have to match, so the drain
    // would be unstoppable by the only control that exists for it.
    const out = resolveLakeId({ target: dbTarget({ lakeIdKind: 'registry' }), lakeRow: null });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.exitCode).toBe(2);
    expect(out.lines[0]).toContain('PauseLakeConvergence');
  });

  it('uses the document _id for a DB lake', () => {
    const out = resolveLakeId({ target: dbTarget(), lakeRow: { _id: { toString: () => 'abc123' } } });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value).toBe('abc123');
  });

  it('refuses a DB lake with no matching datalakes row', () => {
    const out = resolveLakeId({ target: dbTarget(), lakeRow: null });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.exitCode).toBe(2);
    expect(out.lines[0]).toContain('datalake:test-lake');
  });

  it('refuses a DB row whose _id is absent', () => {
    const out = resolveLakeId({ target: dbTarget(), lakeRow: { _id: null } });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.exitCode).toBe(2);
  });
});

describe('buildDrainMembershipQuery', () => {
  it('matches the meta tag OR the prefix, excluding soft-deleted files', () => {
    expect(buildDrainMembershipQuery(dbTarget())).toEqual({
      deletedAt: null,
      $or: [
        { tags: { $elemMatch: { name: 'datalake:test-lake' } } },
        { tags: { $elemMatch: { name: { $regex: '^test:' } } } },
      ],
    });
  });

  it('escapes the prefix, so a metacharacter cannot widen the arm', () => {
    const query = buildDrainMembershipQuery(dbTarget({ prefix: 'a.b+:' })) as {
      $or: { tags: { $elemMatch: { name: { $regex: string } } } }[];
    };
    expect(query.$or[1].tags.$elemMatch.name.$regex).toBe('^a\\.b\\+:');
  });
});

describe('auditOwners', () => {
  it('prints the census commonest-first and does not refuse when every owner is authorized', () => {
    const audit = auditOwners({
      rows: [row(), row({ userId: 'owner-2' }), row({ userId: 'owner-2' })],
      owners: ['owner-1', 'owner-2'],
    });
    expect(audit.lines).toEqual(['  owner owner-2 x2', '  owner owner-1 x1']);
    expect(audit.unauthorized).toEqual([]);
    expect(audit.refusal).toBeNull();
  });

  it('refuses when the unanchored prefix arm reached a file owned outside the allowlist', () => {
    const audit = auditOwners({ rows: [row(), row({ userId: 'stranger' })], owners: ['owner-1'] });
    expect(audit.unauthorized).toEqual(['stranger']);
    expect(audit.lines.find(l => l.includes('stranger'))).toContain('NOT IN THE AUTHORIZED OWNER LIST');
    expect(audit.refusal?.exitCode).toBe(2);
    expect(audit.refusal?.lines.join('\n')).toContain('STOP: the prefix arm reached files owned outside');
  });

  it('fails closed on a file with no owner at all', () => {
    // An ownerless file is the one the queue message cannot resolve access for, so it must not pass
    // as "not in the list of things to worry about".
    const audit = auditOwners({ rows: [row({ userId: undefined })], owners: ['owner-1'] });
    expect(audit.unauthorized).toEqual(['']);
    expect(audit.refusal?.exitCode).toBe(2);
  });

  it('reports an empty census and no refusal for an empty population', () => {
    const audit = auditOwners({ rows: [], owners: ['owner-1'] });
    expect(audit.lines).toEqual([]);
    expect(audit.refusal).toBeNull();
  });
});

describe('checkExpectedPopulation', () => {
  it('stops cleanly on a dry run, printing the population as the number to pass back', () => {
    const out = checkExpectedPopulation({ lake: 'ionq-sales', execute: false, population: 7 });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.exitCode).toBe(0);
    expect(out.lines.join('\n')).toContain('--lake ionq-sales --execute --expect 7');
  });

  it('refuses --execute with no --expect at all', () => {
    const out = checkExpectedPopulation({ lake: 'ionq-sales', execute: true, population: 7 });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.exitCode).toBe(2);
    expect(out.lines[0]).toContain('(absent)');
  });

  it('refuses a population that drifted between the dry run and the execute run', () => {
    const out = checkExpectedPopulation({ lake: 'ionq-sales', execute: true, expect: 7, population: 8 });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.exitCode).toBe(2);
  });

  it('proceeds when the approved count is exactly the measured one', () => {
    expect(checkExpectedPopulation({ lake: 'ionq-sales', execute: true, expect: 8, population: 8 }).ok).toBe(true);
  });

  it('proceeds on an approved empty population', () => {
    expect(checkExpectedPopulation({ lake: 'ionq-sales', execute: true, expect: 0, population: 0 }).ok).toBe(true);
  });
});

describe('planWaves', () => {
  it('tiles the population exactly, remainder last', () => {
    expect(planWaves({ ids: ['a', 'b', 'c', 'd', 'e'], wave: 2 })).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
  });

  it('applies --limit before slicing', () => {
    expect(planWaves({ ids: ['a', 'b', 'c', 'd'], limit: 3, wave: 2 })).toEqual([['a', 'b'], ['c']]);
  });

  it('plans nothing for an empty population', () => {
    expect(planWaves({ ids: [], wave: 50 })).toEqual([]);
  });

  it('throws on a non-positive stride rather than looping forever', () => {
    expect(() => planWaves({ ids: ['a'], wave: 0 })).toThrow(/never terminates/);
    expect(() => planWaves({ ids: ['a'], wave: Number.NaN })).toThrow(/never terminates/);
  });
});

describe('verifyVerdict', () => {
  it('reports converged only when files AND passages are both clean', () => {
    expect(verifyVerdict({ defaultModel: 'm', staleFiles: 0, staleChunks: 0 }).exitCode).toBe(0);
  });

  it('is not satisfied by clean file labels over stale passages', () => {
    // The file label is a stamp, not its vectors: this is the shape where a lake reads healthy
    // everywhere while retrieval scores queries across two spaces with no error raised anywhere.
    const out = verifyVerdict({ defaultModel: 'm', staleFiles: 0, staleChunks: 4200 });
    expect(out.exitCode).toBe(2);
    expect(out.lines.join('\n')).toContain('passages not in m: 4200');
  });

  it('is not satisfied by clean passages over stale file labels', () => {
    expect(verifyVerdict({ defaultModel: 'm', staleFiles: 3, staleChunks: 0 }).exitCode).toBe(2);
  });
});

describe('tally', () => {
  it('counts by the key, commonest first', () => {
    const rows = [row({ embeddingModel: 'a' }), row({ embeddingModel: 'b' }), row({ embeddingModel: 'b' })];
    expect(tally(rows, f => f.embeddingModel ?? 'BLANK')).toBe('b x2, a x1');
  });

  it('names a blank label rather than dropping it', () => {
    expect(tally([row()], f => f.embeddingModel ?? 'BLANK')).toBe('BLANK x1');
  });
});
