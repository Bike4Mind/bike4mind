import { describe, it, expect, vi } from 'vitest';
import type { IDataLakeDocument, ILakeConfigChangeEventDocument, ILakeConfigFieldChange } from '@bike4mind/common';
import {
  assembleLakeConfigHistory,
  clampLakeConfigHistoryLimit,
  toLakeConfigHistoryEntry,
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
  over: { findByIds?: ReturnType<typeof vi.fn>; limit?: number } = {}
) => {
  const listByLake = vi.fn().mockResolvedValue(events);
  const findByIds = over.findByIds ?? vi.fn().mockResolvedValue([]);
  return {
    listByLake,
    findByIds,
    adapters: {
      db: { lakeConfigChangeEvents: { listByLake }, users: { findByIds } as never },
      limit: over.limit,
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
