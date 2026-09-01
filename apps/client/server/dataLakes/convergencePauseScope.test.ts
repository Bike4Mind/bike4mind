import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { provenancePayloadShape, shouldHaltConvergence, SettingScopeLevel } from '@bike4mind/common';
import { invalidateScopedSettingsCache, invalidateSettingsCache } from '@bike4mind/utils';
import {
  buildChunkRescueMessage,
  buildScopedLakeFilter,
  pickScopedLakeId,
  resolveConvergencePauseScope,
  toChunkScanConvergencePause,
  type ConvergencePauseScope,
  type PausableLake,
} from './convergencePauseScope';

const PAUSE_KEY = 'PauseLakeConvergence';
const LAKE_A = '0123456789abcdef01230001';
const LAKE_B = '0123456789abcdef01230002';

const lake = (id: string, overrides: Partial<PausableLake> = {}): PausableLake =>
  ({
    id,
    name: `lake-${id.slice(-1)}`,
    datalakeTag: `datalake:lake-${id.slice(-1)}`,
    createdByUserId: 'creator-1',
    ...overrides,
  }) as PausableLake;

/** A graded lake as resolveConvergencePauseScope builds it - membership scope included. */
const graded = (l: PausableLake, paused: boolean) => ({
  lake: l,
  scope: {
    kind: 'owned' as const,
    datalakeTag: l.datalakeTag,
    fileTagPrefix: l.fileTagPrefix,
    creatorUserId: l.createdByUserId,
  },
  paused,
});

const row = (scopeLevel: SettingScopeLevel, scopeId: string, settingValue: string) => ({
  scopeLevel: scopeLevel as never,
  scopeId,
  settingName: PAUSE_KEY as never,
  settingValue,
});

/** Deps whose three reads are all fixed per test; each can be made to throw. */
const makeDeps = (opts: {
  platform?: unknown;
  rows?: ReturnType<typeof row>[];
  lakes?: PausableLake[];
  throwOn?: 'platform' | 'rows' | 'lakes';
}) => ({
  adminSettings: {
    getSettingsValue: vi.fn(async () => {
      if (opts.throwOn === 'platform') throw new Error('settings table down');
      return opts.platform as never;
    }),
  },
  scopedSettings: {
    findBySettingName: vi.fn(async () => {
      if (opts.throwOn === 'rows') throw new Error('overlay down');
      return (opts.rows ?? []) as never;
    }),
  },
  dataLakes: {
    find: vi.fn(async () => {
      if (opts.throwOn === 'lakes') throw new Error('lakes read down');
      return (opts.lakes ?? []) as never;
    }),
  },
});

const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } as never;

// The resolver reads through process-wide caches; reset both so each test sees its own mocks.
beforeEach(() => {
  vi.clearAllMocks();
  invalidateSettingsCache();
  invalidateScopedSettingsCache();
});

describe('buildScopedLakeFilter (which lakes an override set can reach)', () => {
  it('addresses a lake-rung row by id', () => {
    expect(buildScopedLakeFilter([row(SettingScopeLevel.Lake, LAKE_A, 'true')])).toEqual({
      $or: [{ _id: { $in: [LAKE_A] } }],
    });
  });

  it('matches an owner/org-rung principal against BOTH lake ownership fields', () => {
    // scopeForLake derives the owner rung from organizationId when set and createdByUserId
    // otherwise, so the caller cannot tell which kind of id a row carries - it matches both and lets
    // the grader decide. Narrowing to one field here would strand every override of the other kind.
    expect(buildScopedLakeFilter([row(SettingScopeLevel.Owner, 'principal-1', 'true')])).toEqual({
      $or: [{ createdByUserId: { $in: ['principal-1'] } }, { organizationId: { $in: ['principal-1'] } }],
    });
  });

  it('dedupes ids across rows for the same scope', () => {
    const filter = buildScopedLakeFilter([
      row(SettingScopeLevel.Organization, 'org-1', 'true'),
      row(SettingScopeLevel.Owner, 'org-1', 'false'),
    ]);
    expect(filter).toEqual({
      $or: [{ createdByUserId: { $in: ['org-1'] } }, { organizationId: { $in: ['org-1'] } }],
    });
  });

  it('drops a lake-rung scopeId that is not a hex ObjectId', () => {
    // A malformed id would make Mongoose's cast throw and take the whole sweep down with it, and a
    // crashed sweep is strictly worse than an unhonoured override on one stale row.
    expect(buildScopedLakeFilter([row(SettingScopeLevel.Lake, 'not-an-object-id', 'true')])).toBeNull();
  });

  it('returns null when nothing is addressable, so the caller can skip the lakes read', () => {
    expect(buildScopedLakeFilter([])).toBeNull();
  });
});

describe('resolveConvergencePauseScope', () => {
  it('reads the platform switch strictly - only literal true counts as paused', async () => {
    for (const raw of [undefined, null, 'true', 1, 0, false]) {
      const deps = makeDeps({ platform: raw });
      expect((await resolveConvergencePauseScope(deps, logger)).platformPaused).toBe(false);
    }
    const deps = makeDeps({ platform: true });
    expect((await resolveConvergencePauseScope(deps, logger)).platformPaused).toBe(true);
  });

  it('with NO override rows, never touches the lakes collection', async () => {
    // Gate the work, not the use: with nothing overridden no lake's verdict can differ from the
    // platform switch, so the extra read would be pure waste on every single run.
    const deps = makeDeps({ platform: true, rows: [] });

    const scope = await resolveConvergencePauseScope(deps, logger);

    expect(scope).toEqual({ platformPaused: true, scopedLakes: [] });
    expect(deps.dataLakes.find).not.toHaveBeenCalled();
  });

  it('says so when the switch is ON with no overrides, and stays quiet when it is OFF', async () => {
    // Found by invoking the deployed cron: the fast path logged nothing, so from the outside "resolved,
    // no override exists" was indistinguishable from "the sweep returned before ever resolving the
    // pause". Only ON gets a line - with the switch off there is no verdict to get wrong, and this runs
    // every 60s on self-host.
    await resolveConvergencePauseScope(makeDeps({ platform: true, rows: [] }), logger);
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('platform pause ON; no scoped overrides'));

    vi.clearAllMocks();
    await resolveConvergencePauseScope(makeDeps({ platform: false, rows: [] }), logger);
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('grades the reachable lakes, in both directions against the platform value', async () => {
    const deps = makeDeps({
      platform: false,
      rows: [row(SettingScopeLevel.Lake, LAKE_A, 'true')],
      lakes: [lake(LAKE_A), lake(LAKE_B)],
    });

    const scope = await resolveConvergencePauseScope(deps, logger);

    expect(scope.platformPaused).toBe(false);
    expect(scope.scopedLakes.map(g => [g.lake.id, g.paused])).toEqual([
      [LAKE_A, true],
      // Reachable by the (deliberately over-broad) lake query but not actually addressed by the row,
      // so it falls to the platform value. That is what makes the wide candidate set safe.
      [LAKE_B, false],
    ]);
  });

  it('honours a lake overriding a platform-wide pause back to OFF', async () => {
    const deps = makeDeps({
      platform: true,
      rows: [row(SettingScopeLevel.Lake, LAKE_B, 'false')],
      lakes: [lake(LAKE_B)],
    });

    const scope = await resolveConvergencePauseScope(deps, logger);

    expect(scope).toEqual({ platformPaused: true, scopedLakes: [graded(lake(LAKE_B), false)] });
  });

  it.each([
    ['the platform switch', 'platform' as const, 'settings table down'],
    ['the override set', 'rows' as const, 'overlay down'],
    ['the lakes', 'lakes' as const, 'lakes read down'],
  ])('a failed read of %s aborts the pass instead of answering "not paused"', async (_label, throwOn, message) => {
    // No read here degrades into a verdict. "Unknown means not paused" is the answer that hurts: with
    // the platform switch OFF and the override set unread, the sweep would select a scoped-paused
    // lake's files AND enqueue them with no lakeId, so the handler resolves platform-only too and
    // re-chunks them - rewriting passages an operator froze, and spending embedding budget on it. The
    // only cost of aborting is rescue latency until the next pass.
    const deps = makeDeps({ platform: false, rows: [row(SettingScopeLevel.Lake, LAKE_A, 'true')], throwOn });

    await expect(resolveConvergencePauseScope(deps, logger)).rejects.toThrow(message);
  });

  it('does not read the override set at all when the platform read fails', async () => {
    const deps = makeDeps({ throwOn: 'platform' });

    await expect(resolveConvergencePauseScope(deps, logger)).rejects.toThrow();
    expect(deps.scopedSettings.findBySettingName).not.toHaveBeenCalled();
  });

  it('WARNS and degrades when override rows address nothing queryable', async () => {
    // The one case that is not a read failure: a malformed scopeId is a permanent data condition, so
    // aborting on it would disable the sweep indefinitely rather than until the next pass.
    const deps = makeDeps({ platform: true, rows: [row(SettingScopeLevel.Lake, 'not-an-object-id', 'true')] });

    const scope = await resolveConvergencePauseScope(deps, logger);

    expect(scope).toEqual({ platformPaused: true, scopedLakes: [] });
    expect(deps.dataLakes.find).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('logs how many reachable lakes came back paused, so a lever can be seen firing', async () => {
    const deps = makeDeps({
      platform: false,
      rows: [row(SettingScopeLevel.Lake, LAKE_A, 'true')],
      lakes: [lake(LAKE_A), lake(LAKE_B)],
    });

    await resolveConvergencePauseScope(deps, logger);

    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('1/2 override-reachable lake(s) paused'));
  });
});

describe('pickScopedLakeId (the lakeId the handler re-resolves against)', () => {
  const scopeOf = (
    scopedLakes: ConvergencePauseScope['scopedLakes'],
    platformPaused = false
  ): ConvergencePauseScope => ({
    platformPaused,
    scopedLakes,
  });

  it('is undefined when no lake carries an override, leaving the handler on the platform value', () => {
    expect(pickScopedLakeId({ userId: 'u1', tags: [{ name: 'datalake:lake-1' }] }, scopeOf([]))).toBeUndefined();
  });

  it('resolves membership by the lake meta-tag', () => {
    const scope = scopeOf([graded(lake(LAKE_A), true)]);
    expect(pickScopedLakeId({ userId: 'u1', tags: [{ name: 'datalake:lake-1' }] }, scope)).toBe(LAKE_A);
  });

  it('resolves membership by the prefix arm, anchored to the lake CREATOR owning the file', () => {
    // The same ownership conjunct buildDataLakeMembershipFilter uses. Without it a lake would claim
    // every file in the install carrying its prefix, including other users'.
    const scope = scopeOf([graded(lake(LAKE_A, { fileTagPrefix: 'acme:' }), true)]);

    expect(pickScopedLakeId({ userId: 'creator-1', tags: [{ name: 'acme:legal' }] }, scope)).toBe(LAKE_A);
    expect(pickScopedLakeId({ userId: 'someone-else', tags: [{ name: 'acme:legal' }] }, scope)).toBeUndefined();
  });

  it('is undefined for a file in none of the overridden lakes', () => {
    const scope = scopeOf([graded(lake(LAKE_A), true)]);
    expect(pickScopedLakeId({ userId: 'u1', tags: [{ name: 'datalake:other' }] }, scope)).toBeUndefined();
    expect(pickScopedLakeId({ userId: 'u1', tags: [] }, scope)).toBeUndefined();
    expect(pickScopedLakeId({ userId: 'u1' }, scope)).toBeUndefined();
  });

  it('prefers a PAUSED member lake over a running one, whichever order they arrive in', () => {
    // The conservative direction, and the load-bearing one: chunks are keyed per file and shared by
    // every lake holding it, so re-chunking for the running lake would rewrite the paused lake's
    // passages too - the exact write it asked to stop.
    const candidate = { userId: 'u1', tags: [{ name: 'datalake:lake-1' }, { name: 'datalake:lake-2' }] };
    const running = graded(lake(LAKE_A), false);
    const paused = graded(lake(LAKE_B), true);

    expect(pickScopedLakeId(candidate, scopeOf([running, paused]))).toBe(LAKE_B);
    expect(pickScopedLakeId(candidate, scopeOf([paused, running]))).toBe(LAKE_B);
  });

  it('still stamps a RUNNING member lake, which is how an override of a platform pause is honoured', () => {
    // Omitting it here would leave the handler on the platform value - ON - and halt a file whose
    // lake explicitly overrode the pause back off.
    const scope = scopeOf([graded(lake(LAKE_A), false)], true);
    expect(pickScopedLakeId({ userId: 'u1', tags: [{ name: 'datalake:lake-1' }] }, scope)).toBe(LAKE_A);
  });

  it('ignores malformed tag entries instead of throwing on them', () => {
    const scope = scopeOf([graded(lake(LAKE_A), true)]);
    const candidate = { userId: 'u1', tags: [{ name: null }, {}, { name: 'datalake:lake-1' }] };
    expect(pickScopedLakeId(candidate as never, scope)).toBe(LAKE_A);
  });
});

describe('buildChunkRescueMessage (provenance stamped on the enqueue)', () => {
  const noOverrides: ConvergencePauseScope = { platformPaused: false, scopedLakes: [] };
  const withPausedLake: ConvergencePauseScope = {
    platformPaused: false,
    scopedLakes: [graded(lake(LAKE_A), true)],
  };

  it('stamps convergence origin even on a file in no lake and with no batch (#2309)', () => {
    // A scheduled sweep is background work by definition. An un-stamped message reads as `user`
    // (isConvergenceHalted fails soft), which is never haltable - so a file the chunk handler had
    // just parked as paused came straight back through here and was chunked in full.
    expect(buildChunkRescueMessage({ _id: 'ff1', userId: 'u1' }, noOverrides)).toEqual({
      fabFileId: 'ff1',
      userId: 'u1',
      origin: 'convergence',
    });
  });

  it('sends no lakeId when no override reaches the file, leaving it on the platform value', () => {
    // Absent rather than null: an absent lakeId is what makes the handler resolve the platform
    // switch, which is the right answer for a lake carrying no override.
    expect(buildChunkRescueMessage({ _id: 'ff2', userId: 'u2' }, noOverrides)).not.toHaveProperty('lakeId');
  });

  it('carries origin AND lakeId for a member of an overridden lake', () => {
    expect(
      buildChunkRescueMessage({ _id: 'ff3', userId: 'u3', tags: [{ name: 'datalake:lake-1' }] }, withPausedLake)
    ).toEqual({ fabFileId: 'ff3', userId: 'u3', origin: 'convergence', lakeId: LAKE_A });
  });

  it('is halted by the shape the chunk handler actually parses, not just by carrying an origin key', () => {
    // Binds the stamp to the vocabulary the switch decides on rather than to the string
    // 'convergence': a value outside WORK_ORIGINS parses to undefined, defaults to 'user' and stops
    // being haltable. The consumer's own suite (fabFileChunk.test.ts) covers the handler's half of
    // the contract; this covers the producer's.
    const parsed = z
      .object(provenancePayloadShape)
      .parse(buildChunkRescueMessage({ _id: 'ff1', userId: 'u1' }, noOverrides));
    expect(shouldHaltConvergence(parsed.origin ?? 'user', true)).toBe(true);
  });

  it('stringifies the projected _id and userId', () => {
    const msg = buildChunkRescueMessage(
      { _id: { toString: () => 'oid-1' }, userId: { toString: () => 'uid-1' } },
      noOverrides
    );
    expect(msg).toEqual({ fabFileId: 'oid-1', userId: 'uid-1', origin: 'convergence' });
  });
});

describe('toChunkScanConvergencePause (the selection clause inputs)', () => {
  it('splits the graded lakes by their effective value and carries the platform switch through', () => {
    const pause = toChunkScanConvergencePause({
      platformPaused: true,
      scopedLakes: [
        graded(lake(LAKE_A, { datalakeTag: 'datalake:paused-one' }), true),
        graded(lake(LAKE_B, { datalakeTag: 'datalake:running-one' }), false),
      ],
    });

    expect(pause.platformPaused).toBe(true);
    // Real membership predicates, so the meta arm is observable here; their composition with the
    // sweep's filter is pinned against a live server in chunkScan.e2e.test.ts.
    expect(pause.paused).toEqual([{ 'tags.name': 'datalake:paused-one' }]);
    expect(pause.running).toEqual([{ 'tags.name': 'datalake:running-one' }]);
  });

  it('builds the prefix arm from the lake, so the clause matches the same files pickScopedLakeId does', () => {
    const pause = toChunkScanConvergencePause({
      platformPaused: false,
      scopedLakes: [graded(lake(LAKE_A, { fileTagPrefix: 'acme:' }), true)],
    });

    expect(pause.paused).toEqual([
      {
        $or: [
          { 'tags.name': 'datalake:lake-1' },
          { $and: [{ 'tags.name': { $regex: /^acme:/ } }, { userId: 'creator-1' }] },
        ],
      },
    ]);
  });

  it('is two empty arms when nothing is overridden - the platform-only shape', () => {
    expect(toChunkScanConvergencePause({ platformPaused: true, scopedLakes: [] })).toEqual({
      platformPaused: true,
      paused: [],
      running: [],
    });
  });
});
