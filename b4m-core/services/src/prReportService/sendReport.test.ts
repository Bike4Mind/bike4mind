import { describe, it, expect, vi } from 'vitest';

import { MAX_SEND_TEXT_LENGTH, sendReport, type SendReportDeps, type SendReportParams } from './sendReport';
import type { ChatPostTarget, PostResult, SendDedupeStore, SendReservation } from './types';

const DESTINATION: ChatPostTarget = { token: 'xoxb-super-secret-token', channel: 'C0DIGEST1' };

/**
 * A stand-in for the shared store, with the same three primitives and the same
 * ownership semantics: put-if-absent, compare-and-set, compare-and-delete.
 *
 * Note the real store is Mongo-backed and shared across replicas. These tests assert
 * the ORCHESTRATION; a passing suite over an in-process map would say nothing about
 * cross-replica behaviour, which is exactly why the production store is not one.
 */
function makeStore(seed?: Record<string, SendReservation>) {
  const entries = new Map<string, SendReservation>(Object.entries(seed ?? {}));
  const failures = { reserve: 0, read: 0, markDelivered: 0, release: 0 };
  const calls = { reserve: 0, read: 0, markDelivered: 0, release: 0 };
  /** Runs immediately before a `read` resolves - used to script the release race. */
  let beforeRead: (() => void) | undefined;

  const store: SendDedupeStore = {
    async reserve(key, reservation) {
      calls.reserve++;
      if (failures.reserve > 0) {
        failures.reserve--;
        throw new Error('store unreachable');
      }
      const existing = entries.get(key);
      if (existing) return { reserved: false, existing };
      entries.set(key, { ...reservation });
      return { reserved: true };
    },
    async read(key) {
      calls.read++;
      beforeRead?.();
      beforeRead = undefined;
      if (failures.read > 0) {
        failures.read--;
        throw new Error('store unreachable');
      }
      return entries.get(key) ?? null;
    },
    async markDelivered(key, ownerToken) {
      calls.markDelivered++;
      if (failures.markDelivered > 0) {
        failures.markDelivered--;
        throw new Error('store write failed');
      }
      const existing = entries.get(key);
      if (!existing || existing.ownerToken !== ownerToken) return false;
      entries.set(key, { state: 'delivered', ownerToken });
      return true;
    },
    async release(key, ownerToken) {
      calls.release++;
      if (failures.release > 0) {
        failures.release--;
        throw new Error('store write failed');
      }
      const existing = entries.get(key);
      if (!existing || existing.ownerToken !== ownerToken) return false;
      entries.delete(key);
      return true;
    },
  };

  return {
    store,
    entries,
    calls,
    failures,
    setBeforeRead(fn: () => void) {
      beforeRead = fn;
    },
  };
}

function makeDeps(
  postResult: PostResult | (() => Promise<PostResult>),
  store: SendDedupeStore
): SendReportDeps & { postReport: ReturnType<typeof vi.fn> } {
  const postReport = vi.fn(typeof postResult === 'function' ? postResult : async () => postResult);
  return {
    postReport,
    assertChatTargetFormat: () => undefined,
    dedupeStore: store,
    metrics: { increment: vi.fn() },
  };
}

function params(overrides: Partial<SendReportParams> = {}): SendReportParams {
  return {
    text: '*PR Status Digest*\n• #1 something',
    repo: 'Bike4Mind/bike4mind',
    destination: DESTINATION,
    idempotencyKey: 'key-1',
    ...overrides,
  };
}

describe('sendReport - body validation', () => {
  it('rejects empty text as invalidRequest', async () => {
    const { store } = makeStore();
    const deps = makeDeps({ accepted: true }, store);

    const outcome = await sendReport(params({ text: '   ' }), deps);

    expect(outcome).toEqual({ ok: false, failure: { kind: 'invalidRequest', reason: 'text is empty' } });
    expect(deps.postReport).not.toHaveBeenCalled();
  });

  it('rejects oversized text as invalidRequest', async () => {
    const { store } = makeStore();
    const deps = makeDeps({ accepted: true }, store);

    const outcome = await sendReport(params({ text: 'x'.repeat(MAX_SEND_TEXT_LENGTH + 1) }), deps);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure.kind).toBe('invalidRequest');
    expect(deps.postReport).not.toHaveBeenCalled();
  });
});

describe('sendReport - destination guard', () => {
  it('returns targetRejected before reserving or posting', async () => {
    const { store, calls } = makeStore();
    const deps = makeDeps({ accepted: true }, store);
    deps.assertChatTargetFormat = () => {
      throw new Error('destination host is not on the egress allowlist');
    };

    const outcome = await sendReport(params(), deps);

    expect(outcome).toEqual({
      ok: false,
      failure: { kind: 'targetRejected', reason: 'destination host is not on the egress allowlist' },
    });
    // No reservation behind it, so a provably-unposted digest is not wedged for a TTL.
    expect(calls.reserve).toBe(0);
    expect(deps.postReport).not.toHaveBeenCalled();
  });

  it('does not leak any part of the destination in the failure', async () => {
    const { store } = makeStore();
    const deps = makeDeps({ accepted: true }, store);
    deps.assertChatTargetFormat = () => {
      throw new Error('destination host is not on the egress allowlist');
    };

    const outcome = await sendReport(params(), deps);
    const serialized = JSON.stringify(outcome);

    expect(serialized).not.toContain(DESTINATION.token);
    expect(serialized).not.toContain(DESTINATION.channel);
  });
});

describe('sendReport - happy path and idempotency', () => {
  it('posts once and reports sent', async () => {
    const { store } = makeStore();
    const deps = makeDeps({ accepted: true }, store);

    const outcome = await sendReport(params(), deps);

    expect(outcome).toEqual({ ok: true, response: { outcome: 'sent' } });
    expect(deps.postReport).toHaveBeenCalledTimes(1);
  });

  it('absorbs a retry against a delivered reservation and posts EXACTLY once', async () => {
    const { store } = makeStore();
    const deps = makeDeps({ accepted: true }, store);

    const first = await sendReport(params(), deps);
    const second = await sendReport(params(), deps);

    expect(first).toEqual({ ok: true, response: { outcome: 'sent' } });
    expect(second).toEqual({ ok: true, response: { outcome: 'deduped' } });
    // Asserting the COUNT, not just "not twice" - zero posts also satisfies that.
    expect(deps.postReport).toHaveBeenCalledTimes(1);
  });

  it('dedupes on identical text + repo when no idempotency key is supplied', async () => {
    const { store } = makeStore();
    const deps = makeDeps({ accepted: true }, store);

    await sendReport(params({ idempotencyKey: undefined }), deps);
    const second = await sendReport(params({ idempotencyKey: undefined }), deps);

    expect(second).toEqual({ ok: true, response: { outcome: 'deduped' } });
    expect(deps.postReport).toHaveBeenCalledTimes(1);
  });

  it('treats a different idempotency key as a new send', async () => {
    const { store } = makeStore();
    const deps = makeDeps({ accepted: true }, store);

    await sendReport(params({ idempotencyKey: 'key-1' }), deps);
    const second = await sendReport(params({ idempotencyKey: 'key-2' }), deps);

    expect(second).toEqual({ ok: true, response: { outcome: 'sent' } });
    expect(deps.postReport).toHaveBeenCalledTimes(2);
  });
});

describe('sendReport - concurrent submits', () => {
  it('returns deliveryUnknown, never deduped, when it reads an inFlight reservation', async () => {
    const { store } = makeStore();
    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });

    const deps = makeDeps(async () => {
      await gate;
      return { accepted: true };
    }, store);

    const first = sendReport(params(), deps);
    // The second submit overlaps the first, which is the only way the check-then-post
    // race appears at all.
    const second = await sendReport(params(), deps);

    expect(second).toEqual({ ok: true, response: { outcome: 'deliveryUnknown' } });

    releaseFirst?.();
    expect(await first).toEqual({ ok: true, response: { outcome: 'sent' } });
    expect(deps.postReport).toHaveBeenCalledTimes(1);
  });

  it('re-reserves and posts when the key is released between a failed reserve and the read', async () => {
    // The release race: the first submit comes back notDelivered and releases the key in
    // the gap. An absent read must NOT fall through to deduped - that would return a 200
    // asserting a delivery over a digest that was never sent.
    const seeded = makeStore({ 'seeded-key': { state: 'inFlight', ownerToken: 'other-owner' } });
    const deps = makeDeps({ accepted: true }, seeded.store);

    // Force the key our params hash to be the seeded one by pre-populating on reserve.
    const realReserve = seeded.store.reserve.bind(seeded.store);
    let firstReserve = true;
    seeded.store.reserve = async (key, reservation, ttlMs) => {
      if (firstReserve) {
        firstReserve = false;
        seeded.entries.set(key, { state: 'inFlight', ownerToken: 'other-owner' });
        // Someone else holds it, so this attempt fails...
        return { reserved: false, existing: seeded.entries.get(key) };
      }
      return realReserve(key, reservation, ttlMs);
    };
    // ...and then releases it before we get to read.
    seeded.setBeforeRead(() => seeded.entries.clear());

    const outcome = await sendReport(params(), deps);

    expect(outcome).toEqual({ ok: true, response: { outcome: 'sent' } });
    expect(deps.postReport).toHaveBeenCalledTimes(1);
  });
});

describe('sendReport - ambiguous vs definite failure', () => {
  it('HOLDS the reservation on an ambiguous post and absorbs the retry', async () => {
    const { store, calls } = makeStore();
    const deps = makeDeps({ accepted: false, delivery: 'unknown', reason: 'socket hang up' }, store);

    const first = await sendReport(params(), deps);
    const second = await sendReport(params(), deps);

    expect(first).toEqual({ ok: true, response: { outcome: 'deliveryUnknown' } });
    // The retry is absorbed, not re-posted: the channel sees at most the one post.
    expect(second).toEqual({ ok: true, response: { outcome: 'deliveryUnknown' } });
    expect(deps.postReport).toHaveBeenCalledTimes(1);
    expect(calls.release).toBe(0);
  });

  it('treats a THROWING port as ambiguous and holds', async () => {
    const { store, calls } = makeStore();
    const deps = makeDeps(async () => {
      throw new Error('AbortError: timeout');
    }, store);

    const outcome = await sendReport(params(), deps);

    expect(outcome).toEqual({ ok: true, response: { outcome: 'deliveryUnknown' } });
    expect(calls.release).toBe(0);
  });

  it('RELEASES on a definite non-delivery, and the retry legitimately posts', async () => {
    // The contrasting leg. Without it, a hold-everything implementation passes the
    // ambiguous assertion by wedging every failed send for the full TTL.
    const { store, entries } = makeStore();
    let attempt = 0;
    const deps = makeDeps(async () => {
      attempt++;
      return attempt === 1
        ? { accepted: false, delivery: 'notDelivered', reason: 'channel_not_found' }
        : { accepted: true };
    }, store);

    const first = await sendReport(params(), deps);
    expect(first).toEqual({ ok: false, failure: { kind: 'notDelivered' } });
    expect(entries.size).toBe(0);

    const second = await sendReport(params(), deps);
    expect(second).toEqual({ ok: true, response: { outcome: 'sent' } });
    expect(deps.postReport).toHaveBeenCalledTimes(2);
  });

  it('never returns the provider reason on the notDelivered arm', async () => {
    const { store } = makeStore();
    const deps = makeDeps(
      {
        accepted: false,
        delivery: 'notDelivered',
        // The realistic case: the provider error echoes the credential back.
        reason: `request to ${DESTINATION.token} failed`,
      },
      store
    );

    const outcome = await sendReport(params(), deps);
    const serialized = JSON.stringify(outcome);

    expect(outcome).toEqual({ ok: false, failure: { kind: 'notDelivered' } });
    expect(serialized).not.toContain(DESTINATION.token);
    expect(serialized).not.toContain('channel_not_found');
  });
});

describe('sendReport - stale submits and store failures', () => {
  it('does not let a stale submit clobber a newer delivered reservation', async () => {
    const { store, entries } = makeStore();
    let releasePost: (() => void) | undefined;
    const gate = new Promise<void>(resolve => {
      releasePost = resolve;
    });

    const deps = makeDeps(async () => {
      await gate;
      return { accepted: true };
    }, store);

    const stale = sendReport(params(), deps);
    // Simulate the reservation expiring and a DIFFERENT submit claiming and delivering it.
    await new Promise(resolve => setTimeout(resolve, 0));
    const key = [...entries.keys()][0];
    entries.set(key, { state: 'delivered', ownerToken: 'newer-owner' });

    releasePost?.();
    const outcome = await stale;

    // Its conditional write fails on the owner token, so it cannot claim the newer
    // submit's delivery - and crucially it did not delete it.
    expect(outcome).toEqual({ ok: true, response: { outcome: 'deliveryUnknown' } });
    expect(entries.get(key)).toEqual({ state: 'delivered', ownerToken: 'newer-owner' });
  });

  it('refuses the send when the reserve cannot be confirmed, and does NOT post', async () => {
    const { store, failures } = makeStore();
    failures.reserve = 1;
    const deps = makeDeps({ accepted: true }, store);

    const outcome = await sendReport(params(), deps);

    expect(outcome).toEqual({ ok: false, failure: { kind: 'dedupeUnavailable' } });
    // The count, not just the response - the whole risk is an implementation that logs
    // the store error and carries on unreserved.
    expect(deps.postReport).not.toHaveBeenCalled();
  });

  it('still reports sent when the conditional flip errors after an accepted post', async () => {
    // A different code path from losing ownership: this call watched the delivery happen.
    const { store, failures } = makeStore();
    failures.markDelivered = 1;
    const deps = makeDeps({ accepted: true }, store);

    const outcome = await sendReport(params(), deps);

    expect(outcome).toEqual({ ok: true, response: { outcome: 'sent' } });
    expect(deps.postReport).toHaveBeenCalledTimes(1);
  });

  it('still reports the failed send when the release errors after a definite non-delivery', async () => {
    const { store, failures } = makeStore();
    failures.release = 1;
    const deps = makeDeps({ accepted: false, delivery: 'notDelivered' }, store);

    const outcome = await sendReport(params(), deps);

    expect(outcome).toEqual({ ok: false, failure: { kind: 'notDelivered' } });
  });
});
