import { describe, it, expect, vi } from 'vitest';
import type {
  IDataLakeDocument,
  ILakeConfigChangeEventDocument,
  ILakeConfigFieldChange,
  ILakeMembershipChangeEventDocument,
} from '@bike4mind/common';
import {
  assembleLakeConfigHistory,
  clampLakeConfigHistoryLimit,
  toLakeConfigHistoryEntry,
  toLakeFileHistoryEntry,
  LAKE_CONFIG_HISTORY_LIMIT,
  LAKE_CONFIG_HISTORY_MAX_LIMIT,
} from './assembleLakeConfigHistory';

const lake = (over: Partial<IDataLakeDocument> = {}) =>
  ({ id: 'lake1', name: 'Ops Lake', ...over }) as IDataLakeDocument;

const nameChange: ILakeConfigFieldChange = { field: 'name', kind: 'literal', before: 'a', after: 'b' };

// A stored fingerprint carries a REAL truncated sha256 - that is the value which must not reach the
// wire. Literal hex, not lakeConfigTextFingerprint(...): deriving it from the same helper the code
// uses would make the leak assertions self-referential.
const PROMPT_HASH_BEFORE = 'a1b2c3d4e5f60718';
const PROMPT_HASH_AFTER = '99887766554433aa';
const promptChange: ILakeConfigFieldChange = {
  field: 'systemPrompt',
  kind: 'fingerprint',
  beforeFingerprint: { present: true, length: 139, hash: PROMPT_HASH_BEFORE },
  afterFingerprint: { present: true, length: 204, hash: PROMPT_HASH_AFTER },
};

const event = (over: Partial<ILakeConfigChangeEventDocument> = {}) =>
  ({
    id: 'evt1',
    createdAt: new Date('2026-08-01T00:00:00Z'),
    principalKind: 'user',
    principalId: '000000000000000000000001',
    manageRung: 'grant-owner',
    action: 'update',
    changes: [nameChange],
    ...over,
  }) as ILakeConfigChangeEventDocument;

const adapters = (
  events: ILakeConfigChangeEventDocument[],
  over: {
    findByIds?: ReturnType<typeof vi.fn>;
    find?: ReturnType<typeof vi.fn>;
    limit?: number;
    fileEvents?: ILakeMembershipChangeEventDocument[];
    includeFiles?: boolean;
  } = {}
) => {
  const listByLake = vi.fn().mockResolvedValue(events);
  const listFilesByLake = vi.fn().mockResolvedValue(over.fileEvents ?? []);
  const findByIds = over.findByIds ?? vi.fn().mockResolvedValue([]);
  const find = over.find ?? vi.fn().mockResolvedValue([]);
  return {
    listByLake,
    listFilesByLake,
    findByIds,
    find,
    adapters: {
      db: {
        lakeConfigChangeEvents: { listByLake },
        lakeMembershipChangeEvents: { listByLake: listFilesByLake },
        users: { findByIds } as never,
        userApiKeys: { find } as never,
      },
      limit: over.limit,
      includeFiles: over.includeFiles,
      now: new Date('2026-08-18T12:00:00Z'),
    },
  };
};

describe('clampLakeConfigHistoryLimit', () => {
  it('defaults when absent or non-finite, so a garbage query param serves a page rather than throwing', () => {
    expect(clampLakeConfigHistoryLimit(undefined)).toBe(LAKE_CONFIG_HISTORY_LIMIT);
    expect(clampLakeConfigHistoryLimit(Number.NaN)).toBe(LAKE_CONFIG_HISTORY_LIMIT);
    expect(clampLakeConfigHistoryLimit(Number.POSITIVE_INFINITY)).toBe(LAKE_CONFIG_HISTORY_LIMIT);
  });

  it('clamps to the ceiling so a request cannot ask for an unbounded page', () => {
    expect(clampLakeConfigHistoryLimit(LAKE_CONFIG_HISTORY_MAX_LIMIT + 1_000)).toBe(LAKE_CONFIG_HISTORY_MAX_LIMIT);
  });

  it('floors to 1 rather than 0 or negative, which would make listByLake drop its limit entirely', () => {
    expect(clampLakeConfigHistoryLimit(0)).toBe(1);
    expect(clampLakeConfigHistoryLimit(-5)).toBe(1);
  });

  it('truncates a fractional request instead of passing it to the query', () => {
    expect(clampLakeConfigHistoryLimit(10.9)).toBe(10);
  });
});

describe('toLakeConfigHistoryEntry', () => {
  it('carries the audit facts a reader is owed, keyed by the event id', () => {
    expect(toLakeConfigHistoryEntry(event({ manageRung: 'platform-admin', action: 'visibility' }))).toMatchObject({
      eventId: 'evt1',
      principalKind: 'user',
      manageRung: 'platform-admin',
      action: 'visibility',
      changes: [nameChange],
    });
  });
});

describe('assembleLakeConfigHistory', () => {
  it('returns entries newest-first as listByLake ordered them, without re-sorting or aggregating', async () => {
    const newer = event({ id: 'evt2', createdAt: new Date('2026-08-05T00:00:00Z') });
    const older = event({ id: 'evt1', createdAt: new Date('2026-08-01T00:00:00Z') });
    const { adapters: a } = adapters([newer, older]);
    const view = await assembleLakeConfigHistory(lake(), a);
    expect(view.entries.map(e => e.eventId)).toEqual(['evt2', 'evt1']);
  });

  it('keeps two changes by the same principal as SEPARATE rows - collapsing them would destroy the before -> after chain', async () => {
    const { adapters: a } = adapters([event({ id: 'evt2' }), event({ id: 'evt1' })]);
    const view = await assembleLakeConfigHistory(lake(), a);
    expect(view.entries).toHaveLength(2);
  });

  it('reads the clamped page size, not the raw request', async () => {
    const { listByLake, adapters: a } = adapters([], { limit: LAKE_CONFIG_HISTORY_MAX_LIMIT + 50 });
    await assembleLakeConfigHistory(lake(), a);
    // +1 is the truncation probe, not an off-by-one: see the fetch in assembleLakeConfigHistory.
    expect(listByLake).toHaveBeenCalledWith('lake1', { limit: LAKE_CONFIG_HISTORY_MAX_LIMIT + 1 });
  });

  it('is empty and untruncated for a lake whose history predates the feature', async () => {
    const { adapters: a } = adapters([]);
    const view = await assembleLakeConfigHistory(lake(), a);
    expect(view.entries).toEqual([]);
    expect(view.truncated).toBe(false);
    expect(view.windowStartsAt).toBeUndefined();
  });

  describe('truncation', () => {
    it('flags a genuinely truncated window and carries its oldest event as the start', async () => {
      // limit 2 fetches 3; the third row is the probe proving more exist behind the page.
      const events = [
        event({ id: 'a', createdAt: new Date('2026-08-05T00:00:00Z') }),
        event({ id: 'b', createdAt: new Date('2026-08-01T00:00:00Z') }),
        event({ id: 'probe', createdAt: new Date('2026-07-01T00:00:00Z') }),
      ];
      const { adapters: a } = adapters(events, { limit: 2 });
      const view = await assembleLakeConfigHistory(lake(), a);
      expect(view.truncated).toBe(true);
      // windowStartsAt is the oldest RETURNED event, never the probe - it names where the window
      // begins, and the probe is deliberately outside it.
      expect(view.windowStartsAt).toEqual(new Date('2026-08-01T00:00:00Z'));
    });

    it('never returns the probe row itself, so a page is exactly the size asked for', async () => {
      const events = [event({ id: 'a' }), event({ id: 'b' }), event({ id: 'probe' })];
      const { adapters: a } = adapters(events, { limit: 2 });
      const view = await assembleLakeConfigHistory(lake(), a);
      expect(view.entries).toHaveLength(2);
      expect(view.entries.map(e => e.eventId)).toEqual(['a', 'b']);
    });

    it('does NOT flag a lake holding exactly `limit` events - a complete history is not a window', async () => {
      // The regression this pins: `events.length >= pageSize` off a same-size fetch cannot tell
      // "exactly this many exist" from "more are behind the page", so a lake with precisely 200
      // changes got truncated:true and a windowStartsAt, licensing the UI to caption its whole
      // life as "changes since <date>". The probe row is what makes the two distinguishable.
      const events = [event({ id: 'a' }), event({ id: 'b' })];
      const { adapters: a } = adapters(events, { limit: 2 });
      const view = await assembleLakeConfigHistory(lake(), a);
      expect(view.truncated).toBe(false);
      expect(view.windowStartsAt).toBeUndefined();
      expect(view.entries).toHaveLength(2);
    });

    it('does not flag a partial page', async () => {
      const { adapters: a } = adapters([event()], { limit: 2 });
      const view = await assembleLakeConfigHistory(lake(), a);
      expect(view.truncated).toBe(false);
    });
  });

  /**
   * The disclosure boundary this whole PR exists to hold. The hash is an UNSALTED sha256 of the
   * trimmed prompt, so it is directly checkable against a guessed prompt, and `listByLake` scopes
   * only by `dataLakeId` - so after a transferLakeOwnership a NEW owner reads rows written before
   * they had any access to the lake. "The UI never renders it" is not the same claim as "it never
   * leaves the server", and only the second one is worth anything: the first still ships the value
   * to devtools and to every network log along the way.
   *
   * Asserted against the SERIALIZED view, not against the rendered output - that gap is exactly how
   * this survived a bot review, a security-lens pass and a manual QA that all checked for the prompt
   * TEXT and never for the hash FIELD.
   */
  describe('system-prompt fingerprint disclosure', () => {
    it('never puts the fingerprint hash on the wire, while keeping presence and size', async () => {
      const { adapters: a } = adapters([event({ changes: [promptChange] })]);
      const view = await assembleLakeConfigHistory(lake(), a);

      const change = view.entries[0].changes[0];
      expect(change.kind).toBe('fingerprint');
      if (change.kind !== 'fingerprint') throw new Error('expected the fingerprint arm');
      // What an owner IS owed: that a prompt exists and roughly how big it is.
      expect(change.beforeFingerprint).toEqual({ present: true, length: 139 });
      expect(change.afterFingerprint).toEqual({ present: true, length: 204 });
      // toEqual above already fails on an extra key, but say it outright - this is the invariant.
      expect(change.beforeFingerprint).not.toHaveProperty('hash');
      expect(change.afterFingerprint).not.toHaveProperty('hash');
    });

    it('leaks no hash anywhere in the serialized response, not just in the field we thought to check', async () => {
      // Whole-object sweep rather than a field probe: a future shape change could carry the hash
      // somewhere new, and a targeted assertion would keep passing while the leak moved.
      const { adapters: a } = adapters([event({ changes: [promptChange, nameChange] })]);
      const view = await assembleLakeConfigHistory(lake(), a);

      const wire = JSON.stringify(view);
      expect(wire).not.toContain(PROMPT_HASH_BEFORE);
      expect(wire).not.toContain(PROMPT_HASH_AFTER);
      // Anchored to the JSON KEY, not the bare word: a fixture named "Hashi" or a description
      // mentioning hashing would otherwise redden this for entirely the wrong reason.
      expect(wire).not.toContain('"hash"');
    });

    it('passes the literal arm through untouched - it holds nothing a reader is not already owed', async () => {
      const { adapters: a } = adapters([event({ changes: [nameChange] })]);
      const view = await assembleLakeConfigHistory(lake(), a);
      expect(view.entries[0].changes[0]).toEqual(nameChange);
    });

    it('keeps an ABSENT prompt legible - present:false still crosses, so a clear is not a blank row', async () => {
      const cleared: ILakeConfigFieldChange = {
        field: 'systemPrompt',
        kind: 'fingerprint',
        beforeFingerprint: { present: true, length: 12, hash: PROMPT_HASH_BEFORE },
        afterFingerprint: { present: false, length: 0, hash: '' },
      };
      const { adapters: a } = adapters([event({ changes: [cleared] })]);
      const view = await assembleLakeConfigHistory(lake(), a);

      const change = view.entries[0].changes[0];
      if (change.kind !== 'fingerprint') throw new Error('expected the fingerprint arm');
      expect(change.afterFingerprint).toEqual({ present: false, length: 0 });
    });
  });

  /**
   * `textUnchanged` is the answer that crosses the wire IN PLACE of the hashes, and it alone decides
   * whether a manager reads `formatting only (N chars)` or a misleading `replaced (N -> N chars)`.
   * The consumer side was pinned from the start with a hand-set boolean; the PRODUCER was not, which
   * is the same render-verified / producer-unverified asymmetry that let the hash leak through.
   */
  describe('textUnchanged - the hash comparison, resolved server-side', () => {
    const fingerprintEvent = (
      before: { present: boolean; length: number; hash: string },
      after: { present: boolean; length: number; hash: string }
    ) =>
      event({
        changes: [{ field: 'systemPrompt', kind: 'fingerprint', beforeFingerprint: before, afterFingerprint: after }],
      });

    const textUnchangedOf = async (
      before: { present: boolean; length: number; hash: string },
      after: { present: boolean; length: number; hash: string }
    ) => {
      const { adapters: a } = adapters([fingerprintEvent(before, after)]);
      const view = await assembleLakeConfigHistory(lake(), a);
      const change = view.entries[0].changes[0];
      if (change.kind !== 'fingerprint') throw new Error('expected the fingerprint arm');
      return change.textUnchanged;
    };

    it('is TRUE for equal hashes at different lengths - the whitespace-only save', async () => {
      expect(
        await textUnchangedOf(
          { present: true, length: 120, hash: 'same' },
          { present: true, length: 118, hash: 'same' }
        )
      ).toBe(true);
    });

    it('is FALSE for differing hashes, even at identical lengths', async () => {
      // Equal lengths deliberately: length is NOT the signal, so a rewrite that swapped the hash
      // comparison for a length comparison would pass every other test in this file.
      expect(
        await textUnchangedOf(
          { present: true, length: 120, hash: PROMPT_HASH_BEFORE },
          { present: true, length: 120, hash: PROMPT_HASH_AFTER }
        )
      ).toBe(false);
    });

    it('is FALSE when a side is absent, even though two absent values share the empty-string hash', async () => {
      // The case a naive `before.hash === after.hash` rewrite breaks: '' === '' is true, which would
      // report "text unchanged" for a prompt that was never set on either side, and the consumer
      // would render `formatting only` for a lake that has no prompt at all.
      expect(
        await textUnchangedOf({ present: false, length: 0, hash: '' }, { present: false, length: 0, hash: '' })
      ).toBe(false);
      expect(
        await textUnchangedOf({ present: false, length: 0, hash: '' }, { present: true, length: 9, hash: 'aa' })
      ).toBe(false);
      expect(
        await textUnchangedOf({ present: true, length: 9, hash: 'aa' }, { present: false, length: 0, hash: '' })
      ).toBe(false);
    });
  });

  /**
   * Identity fields carry user ids as their VALUES. Unresolved, the transfer row - the row an owner
   * is most likely to open this surface for - reads as two opaque hex strings in the very column
   * that exists to say what changed, while the Who cell one column left shows a name.
   */
  describe('identity values resolved to names', () => {
    const transfer = (before: string | undefined, after: string) =>
      event({
        action: 'transfer-ownership',
        changes: [{ field: 'effectiveOwnerUserId', kind: 'literal', before, after }],
      });

    it('resolves both sides of a transfer into userNames', async () => {
      // Mock is id-SENSITIVE on purpose: a fixture that returns the same users whatever it is asked
      // for would keep passing even if the identity ids were never collected, which is precisely the
      // regression this test exists to catch.
      const directory: Record<string, string> = {
        '000000000000000000000011': 'Ada Lovelace',
        '000000000000000000000022': 'Grace Hopper',
      };
      const findByIds = vi
        .fn()
        .mockImplementation(async (ids: string[]) =>
          ids.filter(id => directory[id]).map(id => ({ id, name: directory[id] }))
        );
      const { adapters: a } = adapters([transfer('000000000000000000000011', '000000000000000000000022')], {
        findByIds,
      });
      const view = await assembleLakeConfigHistory(lake(), a);

      expect(view.userNames).toEqual({
        '000000000000000000000011': 'Ada Lovelace',
        '000000000000000000000022': 'Grace Hopper',
      });
    });

    it('splits a comma-joined prior-owner set, which is how ownershipChange records it', async () => {
      const findByIds = vi.fn().mockResolvedValue([]);
      const { adapters: a } = adapters(
        [transfer('000000000000000000000011,000000000000000000000022', '000000000000000000000033')],
        { findByIds }
      );
      await assembleLakeConfigHistory(lake(), a);

      // All three identity ids reach the ONE batched lookup - a joined set must not be treated as a
      // single id. The event's own user principal ...0001 rides in the same batch, which is the point.
      expect(findByIds.mock.calls[0][0].sort()).toEqual([
        '000000000000000000000001',
        '000000000000000000000011',
        '000000000000000000000022',
        '000000000000000000000033',
      ]);
    });

    it('folds identity ids into the SAME batch as the principals - one round trip, not two', async () => {
      const findByIds = vi.fn().mockResolvedValue([]);
      const { adapters: a } = adapters([transfer(undefined, '000000000000000000000022')], { findByIds });
      await assembleLakeConfigHistory(lake(), a);
      expect(findByIds).toHaveBeenCalledTimes(1);
    });

    it('does NOT look up organizationId or preferredSystemPromptId - they are ids of other entities', async () => {
      // Resolving these through a USER lookup would produce a confidently wrong name, which is worse
      // than the raw id it replaces.
      const findByIds = vi.fn().mockResolvedValue([]);
      const { adapters: a } = adapters(
        [
          event({
            changes: [
              { field: 'organizationId', kind: 'literal', before: '000000000000000000000044' },
              { field: 'preferredSystemPromptId', kind: 'literal', after: '000000000000000000000055' },
            ],
          }),
        ],
        { findByIds }
      );
      await assembleLakeConfigHistory(lake(), a);

      // Only the event's own user principal is looked up, never the two id-valued non-user fields.
      expect(findByIds.mock.calls[0][0]).toEqual(['000000000000000000000001']);
    });

    it('omits an unresolvable id from userNames, so the consumer falls back to the raw id', async () => {
      const findByIds = vi.fn().mockResolvedValue([]);
      const { adapters: a } = adapters([transfer(undefined, '000000000000000000000099')], { findByIds });
      const view = await assembleLakeConfigHistory(lake(), a);
      expect(view.userNames['000000000000000000000099']).toBeUndefined();
    });

    it('never hands a malformed identity value to findByIds', async () => {
      // Same reason as the principal guard: findByIds throws on a non-24-hex id, which would turn one
      // bad stored value into a 500 for the entire history.
      const findByIds = vi.fn().mockResolvedValue([]);
      const { adapters: a } = adapters([transfer('system', 'not-an-objectid')], { findByIds });
      const view = await assembleLakeConfigHistory(lake(), a);
      expect(findByIds.mock.calls[0][0]).toEqual(['000000000000000000000001']);
      expect(view.userNames).toEqual({});
    });
  });

  describe('principal name resolution', () => {
    it('resolves a user principal and the on-behalf human in ONE batched lookup', async () => {
      const findByIds = vi.fn().mockResolvedValue([
        { id: '000000000000000000000001', name: 'Ada' },
        { id: '000000000000000000000002', name: 'Grace' },
      ]);
      const { adapters: a } = adapters(
        [
          event({
            principalKind: 'apiKey',
            principalId: 'key_abc',
            onBehalfOfUserId: '000000000000000000000002',
          }),
          event({ id: 'evt2', principalId: '000000000000000000000001' }),
        ],
        { findByIds }
      );
      const view = await assembleLakeConfigHistory(lake(), a);
      expect(findByIds).toHaveBeenCalledTimes(1);
      expect(view.entries[0].onBehalfOfName).toBe('Grace');
      expect(view.entries[1].principalName).toBe('Ada');
    });

    it('does not look up a non-user principal - "system" is what a write no principal drove records', async () => {
      const { findByIds, adapters: a } = adapters([event({ principalKind: 'system', principalId: 'system' })]);
      const view = await assembleLakeConfigHistory(lake(), a);
      expect(findByIds).not.toHaveBeenCalled();
      expect(view.entries[0].principalName).toBeUndefined();
    });

    // The two below pin the SHAPE guard specifically, which the principalKind check cannot cover:
    // findByIds throws on a non-24-hex id, so an unguarded one 500s the entire history.
    it('does not look up a user-kind principal whose id is not ObjectId-shaped', async () => {
      const { findByIds } = adapters([]);
      const { adapters: a } = adapters([event({ principalKind: 'user', principalId: 'legacy-principal' })], {
        findByIds,
      });
      const view = await assembleLakeConfigHistory(lake(), a);
      expect(findByIds).not.toHaveBeenCalled();
      expect(view.entries[0].principalName).toBeUndefined();
    });

    it('does not look up a non-ObjectId onBehalfOfUserId - it carries no principalKind to filter on', async () => {
      const { findByIds } = adapters([]);
      const { adapters: a } = adapters(
        [event({ principalKind: 'apiKey', principalId: 'key_abc', onBehalfOfUserId: 'not-an-object-id' })],
        { findByIds }
      );
      const view = await assembleLakeConfigHistory(lake(), a);
      expect(findByIds).not.toHaveBeenCalled();
      expect(view.entries[0].onBehalfOfName).toBeUndefined();
    });

    it('leaves an unresolvable user as its opaque id rather than inventing a name', async () => {
      const { adapters: a } = adapters([event()], { findByIds: vi.fn().mockResolvedValue([]) });
      const view = await assembleLakeConfigHistory(lake(), a);
      expect(view.entries[0].principalName).toBeUndefined();
      expect(view.entries[0].principalId).toBe('000000000000000000000001');
    });

    it('falls back to username, and NEVER to email - a cross-tenant address must not leak as a name', async () => {
      const findByIds = vi
        .fn()
        .mockResolvedValue([{ id: '000000000000000000000001', username: 'ada', email: 'ada@example.com' }]);
      const { adapters: a } = adapters([event()], { findByIds });
      const view = await assembleLakeConfigHistory(lake(), a);
      expect(view.entries[0].principalName).toBe('ada');
    });

    it('does not name a non-user principal even when its id happens to be ObjectId-shaped', async () => {
      const findByIds = vi.fn().mockResolvedValue([{ id: '000000000000000000000001', name: 'Ada' }]);
      const { adapters: a } = adapters([event({ principalKind: 'agent', principalId: '000000000000000000000001' })], {
        findByIds,
      });
      const view = await assembleLakeConfigHistory(lake(), a);
      expect(view.entries[0].principalName).toBeUndefined();
    });
  });

  describe('API-key principals', () => {
    const KEY = '0000000000000000000000aa';
    const USER = '000000000000000000000001';
    // Id-sensitive, like the findByIds fakes: only keys whose id was actually asked for come back.
    const keyFind = (keys: { id: string; name: string }[]) =>
      vi.fn(async (filter: { _id: { $in: string[] } }) => keys.filter(k => filter._id.$in.includes(k.id)));

    it("resolves an apiKey row to the key's name", async () => {
      const find = keyFind([{ id: KEY, name: 'CI key' }]);
      const { adapters: a } = adapters([event({ principalKind: 'apiKey', principalId: KEY })], { find });
      const view = await assembleLakeConfigHistory(lake(), a);
      expect(find).toHaveBeenCalledWith({ _id: { $in: [KEY] } });
      expect(view.entries[0].principalName).toBe('CI key');
    });

    it('leaves a deleted or missing key unnamed so the consumer falls back to the raw id', async () => {
      const { adapters: a } = adapters([event({ principalKind: 'apiKey', principalId: KEY })]);
      const view = await assembleLakeConfigHistory(lake(), a);
      expect(view.entries[0].principalName).toBeUndefined();
      expect(view.entries[0].principalId).toBe(KEY);
    });

    it('never hands a malformed key id to find, so it cannot 500 the view', async () => {
      const { find, adapters: a } = adapters([event({ principalKind: 'apiKey', principalId: 'not-an-oid' })]);
      const view = await assembleLakeConfigHistory(lake(), a);
      expect(find).not.toHaveBeenCalled();
      expect(view.entries[0].principalName).toBeUndefined();
    });

    it('skips the key lookup when the window has no apiKey rows', async () => {
      const { find, adapters: a } = adapters([event()]);
      await assembleLakeConfigHistory(lake(), a);
      expect(find).not.toHaveBeenCalled();
    });

    it('keeps a key name out of userNames and off a user row whose id collides with it', async () => {
      const find = keyFind([{ id: KEY, name: 'CI key' }]);
      const { adapters: a } = adapters(
        [
          event({ id: 'e1', principalKind: 'apiKey', principalId: KEY, onBehalfOfUserId: KEY }),
          event({ id: 'e2', principalKind: 'user', principalId: KEY }),
        ],
        { find }
      );
      const view = await assembleLakeConfigHistory(lake(), a);
      expect(view.entries[0].principalName).toBe('CI key');
      expect(view.entries[0].onBehalfOfName).toBeUndefined();
      expect(view.entries[1].principalName).toBeUndefined();
      expect(view.userNames).toEqual({});
    });

    it('resolves user and apiKey rows side by side, sending findByIds only user ids', async () => {
      const find = keyFind([{ id: KEY, name: 'CI key' }]);
      const findByIds = vi.fn().mockResolvedValue([{ id: USER, name: 'Ada' }]);
      const { adapters: a } = adapters(
        [
          event({ id: 'e1', principalKind: 'apiKey', principalId: KEY, onBehalfOfUserId: USER }),
          event({ id: 'e2', principalKind: 'user', principalId: USER }),
        ],
        { find, findByIds }
      );
      const view = await assembleLakeConfigHistory(lake(), a);
      expect(findByIds).toHaveBeenCalledWith([USER]);
      expect(view.entries.map(e => e.principalName)).toEqual(['CI key', 'Ada']);
      expect(view.entries[0].onBehalfOfName).toBe('Ada');
    });
  });

  it('skips the user lookup entirely when no id is resolvable', async () => {
    const { findByIds, adapters: a } = adapters([]);
    await assembleLakeConfigHistory(lake(), a);
    expect(findByIds).not.toHaveBeenCalled();
  });

  it('stamps the injected clock and echoes the lake identity for the surface header', async () => {
    const { adapters: a } = adapters([]);
    const view = await assembleLakeConfigHistory(lake(), a);
    expect(view).toMatchObject({
      lakeId: 'lake1',
      lakeName: 'Ops Lake',
      generatedAt: new Date('2026-08-18T12:00:00Z'),
    });
  });
});

const fileEvent = (over: Partial<ILakeMembershipChangeEventDocument> = {}) =>
  ({
    id: 'file1',
    createdAt: new Date('2026-08-01T00:00:00Z'),
    principalKind: 'user',
    principalId: '000000000000000000000001',
    fabFileId: 'fab1',
    action: 'added',
    origin: 'person',
    ...over,
  }) as ILakeMembershipChangeEventDocument;

describe('file entries merged into the view', () => {
  it('maps a membership event to a file entry whose target is the file', () => {
    const entry = toLakeFileHistoryEntry(fileEvent({ action: 'removed', undoesEventId: 'e0', causedByEventId: 'e9' }));
    expect(entry).toMatchObject({
      kind: 'file',
      action: 'file-removed',
      target: { kind: 'file', id: 'fab1' },
      origin: 'person',
      undoesEventId: 'e0',
      causedByEventId: 'e9',
    });
  });

  it('returns config rows only, without reading membership events, by default', async () => {
    const { adapters: a, listFilesByLake } = adapters([event({ id: 'c1' })], { fileEvents: [fileEvent()] });
    const view = await assembleLakeConfigHistory(lake(), a);
    expect(view.entries.map(e => e.kind)).toEqual(['config']);
    expect(listFilesByLake).not.toHaveBeenCalled();
  });

  it('interleaves config and file entries in time order, newest first, when files are included', async () => {
    const { adapters: a } = adapters(
      [
        event({ id: 'c1', createdAt: new Date('2026-08-01T10:00:00Z') }),
        event({ id: 'c2', createdAt: new Date('2026-08-01T08:00:00Z') }),
      ],
      {
        includeFiles: true,
        fileEvents: [
          fileEvent({ id: 'f2', createdAt: new Date('2026-08-01T11:00:00Z'), action: 'removed' }),
          fileEvent({ id: 'f1', createdAt: new Date('2026-08-01T09:00:00Z') }),
        ],
      }
    );
    const view = await assembleLakeConfigHistory(lake(), a);
    expect(view.entries.map(e => e.eventId)).toEqual(['f2', 'c1', 'f1', 'c2']);
    expect(view.entries.map(e => e.kind)).toEqual(['file', 'config', 'file', 'config']);
    expect(view.truncated).toBe(false);
    expect(view.windowStartsAt).toBeUndefined();
  });

  it('keeps every config row in the page when a burst of newer file events exceeds the page size', async () => {
    const files = Array.from({ length: 6 }, (_, i) =>
      fileEvent({ id: `f${i}`, createdAt: new Date(Date.UTC(2026, 7, 2, 12, 0, 10 - i)) })
    );
    const { adapters: a } = adapters(
      [
        event({ id: 'c1', createdAt: new Date('2026-08-01T10:00:00Z') }),
        event({ id: 'c2', createdAt: new Date('2026-08-01T09:00:00Z') }),
      ],
      { limit: 2, includeFiles: true, fileEvents: files }
    );
    const view = await assembleLakeConfigHistory(lake(), a);
    expect(view.entries.filter(e => e.kind === 'config').map(e => e.eventId)).toEqual(['c1', 'c2']);
    expect(view.entries.filter(e => e.kind === 'file')).toHaveLength(2);
    expect(view.truncated).toBe(true);
    expect(view.windowStartsAt).toEqual(files[1]!.createdAt);
  });

  it('drops file events older than the oldest kept config row when config is truncated', async () => {
    const { adapters: a } = adapters(
      [
        event({ id: 'c1', createdAt: new Date('2026-08-01T10:00:00Z') }),
        event({ id: 'c2', createdAt: new Date('2026-08-01T09:00:00Z') }),
        event({ id: 'c3', createdAt: new Date('2026-08-01T08:00:00Z') }),
      ],
      {
        limit: 2,
        includeFiles: true,
        fileEvents: [
          fileEvent({ id: 'f1', createdAt: new Date('2026-08-01T09:30:00Z') }),
          fileEvent({ id: 'f2', createdAt: new Date('2026-08-01T08:30:00Z') }),
        ],
      }
    );
    const view = await assembleLakeConfigHistory(lake(), a);
    expect(view.entries.map(e => e.eventId)).toEqual(['c1', 'f1', 'c2']);
    expect(view.truncated).toBe(true);
    expect(view.windowStartsAt).toEqual(new Date('2026-08-01T09:00:00Z'));
  });

  it('flags truncation from files alone and starts the window at the oldest kept file', async () => {
    const { adapters: a } = adapters([event({ id: 'c1', createdAt: new Date('2026-08-01T10:00:00Z') })], {
      limit: 2,
      includeFiles: true,
      fileEvents: [
        fileEvent({ id: 'f1', createdAt: new Date('2026-08-01T09:00:00Z') }),
        fileEvent({ id: 'f2', createdAt: new Date('2026-08-01T08:00:00Z') }),
        fileEvent({ id: 'f3', createdAt: new Date('2026-08-01T07:00:00Z') }),
      ],
    });
    const view = await assembleLakeConfigHistory(lake(), a);
    expect(view.entries.map(e => e.eventId)).toEqual(['c1', 'f1', 'f2']);
    expect(view.truncated).toBe(true);
    expect(view.windowStartsAt).toEqual(new Date('2026-08-01T08:00:00Z'));
  });

  it('does not flag a merged history whose streams each exactly fill the window', async () => {
    const { adapters: a } = adapters([event({ id: 'c1' })], {
      limit: 1,
      includeFiles: true,
      fileEvents: [fileEvent({ id: 'f1' })],
    });
    const view = await assembleLakeConfigHistory(lake(), a);
    expect(view.entries).toHaveLength(2);
    expect(view.truncated).toBe(false);
  });

  it('renders an old config row without the new fields', () => {
    const entry = toLakeConfigHistoryEntry(event());
    expect(entry.kind).toBe('config');
    expect(entry.target).toBeUndefined();
    expect(entry.leverChanges).toBeUndefined();
  });

  it('carries target, leverChanges and the admitted file through', () => {
    const entry = toLakeConfigHistoryEntry(
      event({
        target: { kind: 'proposal', id: 'p1' },
        leverChanges: [{ lever: 'minRelevance', before: 0.6, after: 0.5 }],
        admittedFabFileId: 'fab9',
      })
    );
    expect(entry).toMatchObject({
      target: { kind: 'proposal', id: 'p1' },
      leverChanges: [{ lever: 'minRelevance', before: 0.6, after: 0.5 }],
      admittedFabFileId: 'fab9',
    });
  });
});

describe('undo facts on entries', () => {
  const target = { kind: 'researchConfig' as const, id: 'cfg-1' };
  const lever = [{ lever: 'name', before: 'a', after: 'b' }] as never;
  const withClaims = (
    events: ILakeConfigChangeEventDocument[],
    claims: Array<{ eventId: string; undoEventId?: string }>
  ) => {
    const { adapters: a } = adapters(events);
    return { ...a, db: { ...a.db, lakeConfigUndoClaims: { listForEvents: vi.fn().mockResolvedValue(claims) } } };
  };

  it('marks a recent targeted change undoable', async () => {
    const view = await assembleLakeConfigHistory(
      lake(),
      withClaims([event({ id: 'e1', action: 'update-research-config', target, leverChanges: lever })], [])
    );
    expect(view.entries[0]).toMatchObject({ undoable: true, undone: false });
  });

  it('marks a claimed event undone and links the undoing row when it is in the window', async () => {
    const view = await assembleLakeConfigHistory(
      lake(),
      withClaims(
        [
          event({ id: 'e2', action: 'update-research-config', target, leverChanges: lever, undoesEventId: 'e1' }),
          event({ id: 'e1', action: 'update-research-config', target, leverChanges: lever }),
        ],
        [{ eventId: 'e1', undoEventId: 'e2' }]
      )
    );
    const e1 = view.entries.find(e => e.eventId === 'e1');
    expect(e1).toMatchObject({ undone: true, undoable: false, undoneByEventId: 'e2' });
  });

  it('shows Undone from the claim alone when the undoing row never persisted', async () => {
    const view = await assembleLakeConfigHistory(
      lake(),
      withClaims(
        [event({ id: 'e1', action: 'update-research-config', target, leverChanges: lever })],
        [{ eventId: 'e1' }]
      )
    );
    expect(view.entries[0]).toMatchObject({ undone: true, undoable: false });
    expect(view.entries[0].undoneByEventId).toBeUndefined();
  });

  it('gives an old row with no target no button', async () => {
    const view = await assembleLakeConfigHistory(
      lake(),
      withClaims([event({ id: 'e1', action: 'approve-proposal' })], [])
    );
    expect(view.entries[0].undoable).toBe(false);
  });

  it('leaves the flags off when the caller wires no claims adapter', async () => {
    const { adapters: a } = adapters([
      event({ id: 'e1', action: 'update-research-config', target, leverChanges: lever }),
    ]);
    const view = await assembleLakeConfigHistory(lake(), a);
    expect(view.entries[0].undoable).toBeUndefined();
  });
});

describe('created-config liveness', () => {
  const CFG_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  const CFG_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
  const create = (id: string, cfg: string) =>
    event({ id, action: 'create-research-config', target: { kind: 'researchConfig', id: cfg } });
  const withConfigs = (events: ILakeConfigChangeEventDocument[], live: string[] | undefined) => {
    const { adapters: a } = adapters(events);
    const find = vi.fn().mockResolvedValue((live ?? []).map(id => ({ id })));
    return {
      find,
      adapters: {
        ...a,
        db: {
          ...a.db,
          lakeConfigUndoClaims: { listForEvents: vi.fn().mockResolvedValue([]) },
          ...(live ? { dataLakeResearchConfigs: { find } } : {}),
        },
      },
    };
  };

  it('offers Undo on a create row only while its config still exists, in one batched read', async () => {
    const { adapters: a, find } = withConfigs([create('c1', CFG_A), create('c2', CFG_B)], [CFG_A]);
    const view = await assembleLakeConfigHistory(lake(), a);
    expect(view.entries.find(e => e.eventId === 'c1')?.undoable).toBe(true);
    expect(view.entries.find(e => e.eventId === 'c2')?.undoable).toBe(false);
    expect(find).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith({ dataLakeId: 'lake1', _id: { $in: [CFG_A, CFG_B] } });
  });

  it('does not read configs when no row is a create, and assumes live when the adapter is absent', async () => {
    const none = withConfigs(
      [
        event({
          id: 'u1',
          action: 'update-research-config',
          target: { kind: 'researchConfig', id: CFG_A },
          leverChanges: [{ lever: 'name', before: 'a', after: 'b' }] as never,
        }),
      ],
      []
    );
    await assembleLakeConfigHistory(lake(), none.adapters);
    expect(none.find).not.toHaveBeenCalled();

    const absent = withConfigs([create('c1', CFG_A)], undefined);
    const view = await assembleLakeConfigHistory(lake(), absent.adapters);
    expect(view.entries[0]?.undoable).toBe(true);
  });
});

describe('file names', () => {
  const FAB_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  const FAB_GONE = 'cccccccccccccccccccccccc';
  const build = (rows: Array<Record<string, unknown>>) => {
    const { adapters: a } = adapters([], {
      includeFiles: true,
      fileEvents: [fileEvent({ id: 'f1', fabFileId: FAB_A }), fileEvent({ id: 'f2', fabFileId: FAB_GONE })],
    });
    const find = vi.fn().mockResolvedValue(rows);
    return { find, adapters: { ...a, db: { ...a.db, fabFiles: { find } } } };
  };

  const MEMBER_TAGS = [{ name: 'datalake:ops', strength: 1 }];
  const memberLake = () => lake({ datalakeTag: 'datalake:ops', fileTagPrefix: 'ops:', createdByUserId: 'creator' });

  it('names each file in one batched read, and leaves a deleted file without a name', async () => {
    const { adapters: a, find } = build([{ id: FAB_A, fileName: 'handbook.pdf', userId: 'u1', tags: MEMBER_TAGS }]);
    const view = await assembleLakeConfigHistory(memberLake(), a);
    const byId = Object.fromEntries(view.entries.map(e => [e.eventId, e]));
    expect(byId.f1).toMatchObject({ fileName: 'handbook.pdf' });
    expect(byId.f2).not.toHaveProperty('fileName');
    expect(find).toHaveBeenCalledTimes(1);
  });

  it('ignores a soft-deleted file row', async () => {
    const { adapters: a } = build([
      { id: FAB_A, fileName: 'old.pdf', userId: 'u1', tags: MEMBER_TAGS, deletedAt: new Date() },
    ]);
    const view = await assembleLakeConfigHistory(memberLake(), a);
    expect(view.entries[0]).not.toHaveProperty('fileName');
  });

  it('names a file that matches the lake through the creator-owned prefix arm', async () => {
    const { adapters: a } = build([
      { id: FAB_A, fileName: 'prefixed.pdf', userId: 'creator', tags: [{ name: 'ops:q3', strength: 1 }] },
    ]);
    const view = await assembleLakeConfigHistory(memberLake(), a);
    const byId = Object.fromEntries(view.entries.map(e => [e.eventId, e]));
    expect(byId.f1).toMatchObject({ fileName: 'prefixed.pdf' });
  });

  it('leaves a file that is no longer in the lake without a name', async () => {
    const { adapters: a } = build([
      { id: FAB_A, fileName: 'left.pdf', userId: 'u1', tags: [{ name: 'other', strength: 1 }] },
    ]);
    const view = await assembleLakeConfigHistory(memberLake(), a);
    const byId = Object.fromEntries(view.entries.map(e => [e.eventId, e]));
    expect(byId.f1).not.toHaveProperty('fileName');
  });

  it('does not name a non-creator file through the prefix arm', async () => {
    const { adapters: a } = build([
      { id: FAB_A, fileName: 'foreign.pdf', userId: 'u1', tags: [{ name: 'ops:q3', strength: 1 }] },
    ]);
    const view = await assembleLakeConfigHistory(memberLake(), a);
    const byId = Object.fromEntries(view.entries.map(e => [e.eventId, e]));
    expect(byId.f1).not.toHaveProperty('fileName');
  });

  it('names a file that left the lake when the reader owns it', async () => {
    const { adapters: a } = build([{ id: FAB_A, fileName: 'mine.pdf', userId: 'reader', tags: [] }]);
    const view = await assembleLakeConfigHistory(memberLake(), { ...a, viewerUserId: 'reader' });
    const byId = Object.fromEntries(view.entries.map(e => [e.eventId, e]));
    expect(byId.f1).toMatchObject({ fileName: 'mine.pdf' });
  });

  it('does not read files when no file rows are returned', async () => {
    const { adapters: a } = adapters([event({ id: 'c1' })]);
    const find = vi.fn();
    await assembleLakeConfigHistory(lake(), { ...a, db: { ...a.db, fabFiles: { find } } } as never);
    expect(find).not.toHaveBeenCalled();
  });
});
