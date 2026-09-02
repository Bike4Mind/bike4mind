import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { provenancePayloadShape, shouldHaltConvergence, SettingScopeLevel } from '@bike4mind/common';
import { invalidateScopedSettingsCache, invalidateSettingsCache } from '@bike4mind/utils';
import {
  buildChunkRescueMessage,
  buildScopedLakeFilter,
  pickScopedLake,
  resolveConvergencePauseScope,
  resolvePlatformOnlyMembership,
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
  findPausableLakes: vi.fn(async () => {
    if (opts.throwOn === 'lakes') throw new Error('lakes read down');
    return opts.lakes ?? [];
  }),
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

  it('names each dropped row, even when the batch still produces a filter', () => {
    // The silent case: with one bad row among good ones the sweep runs normally and that lake's
    // override is simply not honoured - "I paused it and it kept chunking", with nothing in the log
    // to explain it. The offending scopeId has to be IN the line to be actionable.
    const filter = buildScopedLakeFilter(
      [row(SettingScopeLevel.Lake, 'not-an-object-id', 'true'), row(SettingScopeLevel.Lake, LAKE_A, 'true')],
      logger
    );

    expect(filter).toEqual({ $or: [{ _id: { $in: [LAKE_A] } }] });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('not-an-object-id'));
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

    expect(scope).toEqual({ platformPaused: true, scopedLakes: [], platformOnlyMembership: [] });
    expect(deps.findPausableLakes).not.toHaveBeenCalled();
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

    expect(scope).toEqual({
      platformPaused: true,
      scopedLakes: [graded(lake(LAKE_B), false)],
      platformOnlyMembership: [],
    });
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

    expect(scope).toEqual({ platformPaused: true, scopedLakes: [], platformOnlyMembership: [] });
    expect(deps.findPausableLakes).not.toHaveBeenCalled();
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

describe('resolvePlatformOnlyMembership (the lakes the override set cannot see)', () => {
  const exemptScope = (): ConvergencePauseScope => ({
    platformPaused: true,
    scopedLakes: [graded(lake(LAKE_A), false)],
    platformOnlyMembership: [],
  });
  const candidate = { userId: 'u1', tags: [{ name: 'datalake:lake-1', strength: 1 }] };

  it.each([
    ['the platform switch is OFF, so nothing invisible is paused', { platformPaused: false, exemptPaused: true }],
    ['no override exempts a lake, so a running verdict is impossible', { platformPaused: true, exemptPaused: true }],
  ])('is a no-op and reads nothing when %s', async (_label, { platformPaused, exemptPaused }) => {
    const deps = makeDeps({});
    const scope: ConvergencePauseScope = {
      platformPaused,
      scopedLakes: [graded(lake(LAKE_A), exemptPaused)],
      platformOnlyMembership: [],
    };

    await expect(resolvePlatformOnlyMembership(scope, [candidate], deps, logger)).resolves.toBe(scope);
    expect(deps.findPausableLakes).not.toHaveBeenCalled();
  });

  it('queries by the CANDIDATES, so the read is bounded by the run and not by the install', async () => {
    // Both arms of buildDataLakeMembershipFilter, inverted: the meta arm needs the lake's
    // datalakeTag on a candidate's tags, the owned prefix arm needs the candidate's userId to be
    // the lake's creator. Both fields are indexed, and both key sets come off this run's candidates.
    const deps = makeDeps({});

    await resolvePlatformOnlyMembership(
      exemptScope(),
      [
        { userId: 'u1', tags: [{ name: 'datalake:lake-1', strength: 1 }, { name: 'acme:legal', strength: 1 }] },
        { userId: 'u2', tags: [{ name: 'datalake:other', strength: 1 }] },
      ],
      deps,
      logger
    );

    expect(deps.findPausableLakes).toHaveBeenCalledWith({
      $or: [
        // Only `datalake:`-prefixed tags - a content tag names no lake and would widen the read.
        { datalakeTag: { $in: ['datalake:lake-1', 'datalake:other'] } },
        { createdByUserId: { $in: ['u1', 'u2'] } },
      ],
    });
  });

  it('keeps the lakes the override set does NOT reach, and drops the ones it already graded', async () => {
    const deps = makeDeps({ lakes: [lake(LAKE_A), lake(LAKE_B)] });

    const scope = await resolvePlatformOnlyMembership(exemptScope(), [candidate], deps, logger);

    // LAKE_A is already in scopedLakes with a real verdict; re-listing it as paused would override
    // the very exemption this run is honouring.
    expect(scope.platformOnlyMembership).toContainEqual({
      kind: 'owned',
      datalakeTag: 'datalake:lake-2',
      fileTagPrefix: undefined,
      creatorUserId: 'creator-1',
    });
    expect(scope.platformOnlyMembership).not.toContainEqual(expect.objectContaining({ datalakeTag: 'datalake:lake-1' }));
  });

  it('always includes the static registry, which no override can ever reach', async () => {
    // Registry lakes have no document to find and can carry no override, but they hold real files -
    // so with the switch ON they are paused and their passages need the same protection.
    const deps = makeDeps({ lakes: [] });

    const scope = await resolvePlatformOnlyMembership(exemptScope(), [candidate], deps, logger);

    expect(scope.platformOnlyMembership.some(m => m.kind === 'registry')).toBe(true);
  });

  it('skips the read entirely when the candidates address no lake at all', async () => {
    const deps = makeDeps({});

    const scope = await resolvePlatformOnlyMembership(exemptScope(), [{ userId: null, tags: [] }], deps, logger);

    expect(deps.findPausableLakes).not.toHaveBeenCalled();
    // The registry still applies - it is free and independent of the candidates.
    expect(scope.platformOnlyMembership.every(m => m.kind === 'registry')).toBe(true);
  });
});

describe('pickScopedLake (the lakeId the handler re-resolves against)', () => {
  const scopeOf = (
    scopedLakes: ConvergencePauseScope['scopedLakes'],
    platformPaused = false,
    platformOnlyMembership: ConvergencePauseScope['platformOnlyMembership'] = []
  ): ConvergencePauseScope => ({
    platformPaused,
    scopedLakes,
    platformOnlyMembership,
  });

  it('is undefined when no lake carries an override, leaving the handler on the platform value', () => {
    expect(pickScopedLake({ userId: 'u1', tags: [{ name: 'datalake:lake-1' }] }, scopeOf([])).lakeId).toBeUndefined();
  });

  it('resolves membership by the lake meta-tag', () => {
    const scope = scopeOf([graded(lake(LAKE_A), true)]);
    expect(pickScopedLake({ userId: 'u1', tags: [{ name: 'datalake:lake-1' }] }, scope).lakeId).toBe(LAKE_A);
  });

  it('resolves membership by the prefix arm, anchored to the lake CREATOR owning the file', () => {
    // The same ownership conjunct buildDataLakeMembershipFilter uses. Without it a lake would claim
    // every file in the install carrying its prefix, including other users'.
    const scope = scopeOf([graded(lake(LAKE_A, { fileTagPrefix: 'acme:' }), true)]);

    expect(pickScopedLake({ userId: 'creator-1', tags: [{ name: 'acme:legal' }] }, scope).lakeId).toBe(LAKE_A);
    expect(pickScopedLake({ userId: 'someone-else', tags: [{ name: 'acme:legal' }] }, scope).lakeId).toBeUndefined();
  });

  it('is undefined for a file in none of the overridden lakes', () => {
    const scope = scopeOf([graded(lake(LAKE_A), true)]);
    expect(pickScopedLake({ userId: 'u1', tags: [{ name: 'datalake:other' }] }, scope).lakeId).toBeUndefined();
    expect(pickScopedLake({ userId: 'u1', tags: [] }, scope).lakeId).toBeUndefined();
    expect(pickScopedLake({ userId: 'u1' }, scope).lakeId).toBeUndefined();
  });

  it('prefers a PAUSED member lake over a running one, whichever order they arrive in', () => {
    // The conservative direction, and the load-bearing one: chunks are keyed per file and shared by
    // every lake holding it, so re-chunking for the running lake would rewrite the paused lake's
    // passages too - the exact write it asked to stop.
    const candidate = { userId: 'u1', tags: [{ name: 'datalake:lake-1' }, { name: 'datalake:lake-2' }] };
    const running = graded(lake(LAKE_A), false);
    const paused = graded(lake(LAKE_B), true);

    expect(pickScopedLake(candidate, scopeOf([running, paused])).lakeId).toBe(LAKE_B);
    expect(pickScopedLake(candidate, scopeOf([paused, running])).lakeId).toBe(LAKE_B);
  });

  it('still stamps a RUNNING member lake, which is how an override of a platform pause is honoured', () => {
    // Omitting it here would leave the handler on the platform value - ON - and halt a file whose
    // lake explicitly overrode the pause back off.
    const scope = scopeOf([graded(lake(LAKE_A), false)], true);
    expect(pickScopedLake({ userId: 'u1', tags: [{ name: 'datalake:lake-1' }] }, scope).lakeId).toBe(LAKE_A);
  });

  it('refuses to stamp a running lake for a file an UNGRADED lake also holds', () => {
    // The gap the "paused wins" invariant used to have: an ungraded lake carries no override, so it
    // sits at the platform value - ON here - and is invisible to scopedLakes. Stamping the exempted
    // lake would un-pause the file and re-chunk it, rewriting the passages the other lake froze.
    // Chunks are keyed per file and shared, so there is no way to rebuild one lake's and not the
    // other's. No lakeId leaves the handler on the platform value, which is the paused verdict.
    const scope = scopeOf([graded(lake(LAKE_A), false)], true, [
      { kind: 'owned', datalakeTag: 'datalake:frozen', creatorUserId: 'creator-9' },
    ]);
    const candidate = { userId: 'u1', tags: [{ name: 'datalake:lake-1' }, { name: 'datalake:frozen' }] };

    // Still IN a lake, though: without that the message would carry no origin either and go out as
    // user work, which nothing halts - the exact opposite of this verdict.
    expect(pickScopedLake(candidate, scope)).toEqual({});
    // ...and a file the ungraded lake does NOT hold is still exempted, or the fix would have turned
    // the override into a no-op for every multi-lake install.
    expect(pickScopedLake({ userId: 'u1', tags: [{ name: 'datalake:lake-1' }] }, scope).lakeId).toBe(LAKE_A);
  });

  it('marks a file held ONLY by an ungraded lake haltable, with no lakeId to resolve', () => {
    const scope = scopeOf([graded(lake(LAKE_A), false)], true, [
      { kind: 'owned', datalakeTag: 'datalake:frozen', creatorUserId: 'creator-9' },
    ]);

    expect(pickScopedLake({ userId: 'u1', tags: [{ name: 'datalake:frozen' }] }, scope)).toEqual({});
  });

  it('lets an explicitly PAUSED member win over an ungraded one, so the stamp keeps its provenance', () => {
    // Both verdicts halt the file, so this is about which one the handler logs. A graded paused lake
    // is a real lakeId the handler resolves; the ungraded path deliberately stamps nothing.
    const scope = scopeOf([graded(lake(LAKE_A), true)], true, [
      { kind: 'owned', datalakeTag: 'datalake:frozen', creatorUserId: 'creator-9' },
    ]);
    const candidate = { userId: 'u1', tags: [{ name: 'datalake:lake-1' }, { name: 'datalake:frozen' }] };

    expect(pickScopedLake(candidate, scope).lakeId).toBe(LAKE_A);
  });

  it('ignores malformed tag entries instead of throwing on them', () => {
    const scope = scopeOf([graded(lake(LAKE_A), true)]);
    const candidate = { userId: 'u1', tags: [{ name: null }, {}, { name: 'datalake:lake-1' }] };
    expect(pickScopedLake(candidate as never, scope).lakeId).toBe(LAKE_A);
  });
});

describe('buildChunkRescueMessage (provenance stamped on the enqueue)', () => {
  const noOverrides: ConvergencePauseScope = { platformPaused: false, scopedLakes: [], platformOnlyMembership: [] };
  const withPausedLake: ConvergencePauseScope = {
    platformPaused: false,
    scopedLakes: [graded(lake(LAKE_A), true)],
    platformOnlyMembership: [],
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

  it('THROWS on a candidate with no userId instead of sending the string "undefined"', () => {
    // userId is required on every FabFile, so this is a corrupt row. The sweep's per-file catch
    // turns the throw into a counted failure with the fabFileId logged; String(undefined) instead
    // satisfies the handler's z.string() and becomes an owner id no user has, moving the failure
    // downstream and losing the one identifier that would locate it.
    expect(() => buildChunkRescueMessage({ _id: 'ff9' }, noOverrides)).toThrow(/ff9/);
    expect(() => buildChunkRescueMessage({ _id: 'ff9', userId: null }, noOverrides)).toThrow(/no userId/);
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
      platformOnlyMembership: [],
    });

    expect(pause.platformPaused).toBe(true);
    // Real membership predicates, so the meta arm is observable here; their composition with the
    // sweep's filter is pinned against a live server in chunkScan.e2e.test.ts.
    expect(pause.paused).toEqual([{ 'tags.name': 'datalake:paused-one' }]);
    expect(pause.running).toEqual([{ 'tags.name': 'datalake:running-one' }]);
  });

  it('builds the prefix arm from the lake, so the clause matches the same files pickScopedLake does', () => {
    const pause = toChunkScanConvergencePause({
      platformPaused: false,
      scopedLakes: [graded(lake(LAKE_A, { fileTagPrefix: 'acme:' }), true)],
      platformOnlyMembership: [],
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
    expect(
      toChunkScanConvergencePause({ platformPaused: true, scopedLakes: [], platformOnlyMembership: [] })
    ).toEqual({
      platformPaused: true,
      paused: [],
      running: [],
    });
  });
});
