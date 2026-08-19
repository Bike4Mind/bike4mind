/**
 * `createLedgerAppendSession` is the batch write seam that fixes the quadratic profile read (#1501): the
 * per-fact path decrypted the whole append-only chain once PER FACT, so a producer folding a data lake
 * paid O(facts x chain). These tests pin the two properties that make the hoist correct rather than just
 * faster:
 *   1. the profile is read ONCE for the whole run (and only when a fact actually carries an embedding), and
 *   2. de-dup still coalesces a later fact with an earlier one from the SAME run - the behaviour the
 *      per-fact re-read used to give for free, now carried by an in-memory set kept current as it writes.
 *
 * `appendMemoryEvent` and the profile read are mocked (this is not a persistence test); `resolveSubject`
 * and `cosineSimilarity` are the REAL implementations, so subject selection is exercised for real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const appendMemoryEventMock = vi.fn();
const readProfileMock = vi.fn();

vi.mock('@bike4mind/database', () => ({
  memoryLedgerRepository: {},
  memoryPrincipalKeyRepository: {},
  userRepository: {},
}));
vi.mock('@bike4mind/common', () => ({
  MEMENTO_DEDUP_SIMILARITY: 0.85,
  isExperimentalFeatureEnabled: () => false,
}));
vi.mock('./ledgerMemoryStore', () => ({
  appendMemoryEvent: (...a: unknown[]) => appendMemoryEventMock(...a),
  createLedgerMemoryStore: () => ({ readProfile: (...a: unknown[]) => readProfileMock(...a) }),
}));
vi.mock('./factCipher', () => ({ createKeyProvider: () => ({}) }));

const { createLedgerAppendSession } = await import('./mementoLedgerMirror');
const { resolveSubject } = await import('@bike4mind/memory');

// The subject/options a captured appendMemoryEvent call was made with.
const callSubject = (i: number) => appendMemoryEventMock.mock.calls[i][3].subject as string;
const callHashed = (i: number) => appendMemoryEventMock.mock.calls[i][4].subjectIsHashed as boolean;

const LAKE = { principal: { kind: 'lake' as const, id: 'datalake:test' }, ownerUserId: 'owner-1' };

describe('createLedgerAppendSession - hoisted de-dup (#1501)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appendMemoryEventMock.mockResolvedValue(undefined);
  });

  it('reads the profile once for the whole run and coalesces across existing AND same-run beliefs', async () => {
    // One existing belief whose id IS its stored subject HMAC, embedded near [1,0,0].
    readProfileMock.mockResolvedValue({
      principal: LAKE.principal,
      beliefs: [{ id: 'HMAC_existing', shredded: false, embedding: [1, 0, 0] }],
    });

    const session = await createLedgerAppendSession(LAKE);

    // Two facts near the existing belief -> both assert under its HMAC, marked already-hashed.
    await session.append({
      summary: 'the reactor core temperature is 900 degrees',
      evidenceTier: 'external-facing',
      embedding: [1, 0, 0],
    });
    await session.append({
      summary: 'reactor core runs at nine hundred degrees celsius',
      evidenceTier: 'external-facing',
      embedding: [1, 0, 0],
    });

    // A fact orthogonal to the existing belief -> a NEW plaintext subject.
    const f3 = 'the coolant pump model is XZ-40';
    await session.append({ summary: f3, evidenceTier: 'external-facing', embedding: [0, 1, 0] });
    // A fourth fact near f3 (but far from the existing belief) must coalesce with f3 - proving the
    // in-memory set carries same-run writes, which a hoisted single read would otherwise miss.
    await session.append({
      summary: 'coolant pump is the XZ-40 unit',
      evidenceTier: 'external-facing',
      embedding: [0, 1, 0],
    });

    expect(appendMemoryEventMock).toHaveBeenCalledTimes(4);
    expect(callSubject(0)).toBe('HMAC_existing');
    expect(callHashed(0)).toBe(true);
    expect(callSubject(1)).toBe('HMAC_existing');
    expect(callHashed(1)).toBe(true);

    const f3Subject = resolveSubject({ fact: f3 });
    expect(callSubject(2)).toBe(f3Subject);
    expect(callHashed(2)).toBe(false);
    // f4 coalesced with f3: same subject, still plaintext (a freshly derived subject, not an HMAC).
    expect(callSubject(3)).toBe(f3Subject);
    expect(callHashed(3)).toBe(false);

    // The whole point: ONE profile read, not one per fact.
    expect(readProfileMock).toHaveBeenCalledTimes(1);
  });

  it('never reads the profile when no fact carries an embedding (lazy load)', async () => {
    const session = await createLedgerAppendSession(LAKE);

    await session.append({ summary: 'a durable fact with no vector', evidenceTier: 'external-facing' });

    expect(appendMemoryEventMock).toHaveBeenCalledTimes(1);
    expect(callHashed(0)).toBe(false); // fresh plaintext subject
    expect(readProfileMock).not.toHaveBeenCalled();
  });

  it('falls back to writing (no coalesce) when the profile read fails', async () => {
    readProfileMock.mockRejectedValue(new Error('mongo down'));
    const session = await createLedgerAppendSession(LAKE);

    const summary = 'a fact whose de-dup lookup could not run';
    await session.append({ summary, evidenceTier: 'external-facing', embedding: [1, 0, 0] });

    // The fact is still written, under its freshly derived (plaintext) subject.
    expect(appendMemoryEventMock).toHaveBeenCalledTimes(1);
    expect(callSubject(0)).toBe(resolveSubject({ fact: summary }));
    expect(callHashed(0)).toBe(false);
  });
});
