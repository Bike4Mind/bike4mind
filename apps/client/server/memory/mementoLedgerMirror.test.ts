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

const { createLedgerAppendSession, writeFactToLedger } = await import('./mementoLedgerMirror');
const { figureScopedSubject, resolveSubject } = await import('@bike4mind/memory');

// The subject/options a captured appendMemoryEvent call was made with.
const callSubject = (i: number) => appendMemoryEventMock.mock.calls[i][3].subject as string;
const callHashed = (i: number) => appendMemoryEventMock.mock.calls[i][4].subjectIsHashed as boolean;

const LAKE = {
  principal: { kind: 'lake' as const, id: 'datalake:test' },
  ownerUserId: 'owner-1',
  startedAt: new Date('2026-01-01T00:00:00.000Z'),
};

describe('createLedgerAppendSession - hoisted de-dup (#1501)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // A truthy sealed event: the session now reads a falsy return as a shred REFUSAL and stops, so a
    // mock resolving undefined would silently make every append look declined.
    appendMemoryEventMock.mockResolvedValue({ seq: 0, hash: 'h', prevHash: null });
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

  it('returns false on a shred refusal and keeps the refused belief OUT of the de-dup set', async () => {
    // Ordering is the property here, not just the boolean. Recording a refused belief would make a
    // later fact in the same run coalesce onto a subject that was never written: the assert would key
    // on a non-existent belief, so the fact ends up unreachable rather than merely unwritten.
    readProfileMock.mockResolvedValue({ principal: LAKE.principal, beliefs: [] });
    const session = await createLedgerAppendSession(LAKE);

    appendMemoryEventMock.mockResolvedValueOnce(null);
    const refused = await session.append({
      summary: 'the coolant pump model is XZ-40',
      evidenceTier: 'external-facing',
      embedding: [0, 1, 0],
    });
    expect(refused).toBe(false);

    // A near-identical later fact keys on its OWN fresh subject, exactly as if the first append had
    // never happened. Were the refused belief in the set, this would coalesce onto its subject instead.
    const second = 'coolant pump is the XZ-40 unit';
    const sealed = await session.append({ summary: second, evidenceTier: 'external-facing', embedding: [0, 1, 0] });

    expect(sealed).toBe(true);
    expect(appendMemoryEventMock).toHaveBeenCalledTimes(2);
    expect(callSubject(1)).toBe(resolveSubject({ fact: second }));
    expect(callHashed(1)).toBe(false);
  });

  it('returns true for a content-free summary, so a caller counting refusals does not miscount it', async () => {
    // `true` means "nothing to write", NOT "written" - and it must not be conflated with a refusal:
    // extractLakeMemory reads false as a shred refusal and stops the run, so returning false for an
    // unkeyable summary would abort healthy runs on the first stopword-only fact.
    const session = await createLedgerAppendSession(LAKE);

    expect(await session.append({ summary: '   ', evidenceTier: 'external-facing' })).toBe(true);
    expect(appendMemoryEventMock).not.toHaveBeenCalled();
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

/**
 * Two documents disagreeing about one figure (#1501 item 4).
 *
 * De-dup coalesces on embedding cosine, and an assert on an existing subject REPLACES that belief, so
 * before this guard the lake kept only whichever document was extracted last - the other reading was
 * destroyed, provenance included. Measured against the live embedding model, two readings of one
 * metric sit at ~0.99 cosine, so this is the common case rather than a corner one.
 *
 * These fixtures use hand-written vectors (the real `cosineSimilarity` runs), so "near-duplicate" here
 * means the same thing it means in production: over `MEMENTO_DEDUP_SIMILARITY`.
 */
describe('createLedgerAppendSession - preserving a disagreement (#1501)', () => {
  const NEAR = [1, 0, 0]; // identical vectors: unambiguously over the de-dup threshold
  const existingBelief = (fact: string, sources: string[]) => ({
    principal: LAKE.principal,
    beliefs: [{ id: 'HMAC_existing', shredded: false, embedding: NEAR, fact, sources }],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    appendMemoryEventMock.mockResolvedValue({ seq: 0, hash: 'h', prevHash: null });
  });

  it('keeps both readings when two documents disagree on a figure', async () => {
    readProfileMock.mockResolvedValue(existingBelief('Uptime is 99.9%', ['docA']));
    const session = await createLedgerAppendSession(LAKE);

    await session.append({
      summary: 'Uptime is 99.5%',
      evidenceTier: 'external-facing',
      sources: ['docB'],
      embedding: NEAR,
    });

    // Not asserted onto the existing belief's HMAC - that is what would have destroyed it.
    expect(callSubject(0)).not.toBe('HMAC_existing');
    expect(callHashed(0)).toBe(false);
  });

  it('does not let the preserved reading hash back onto the belief it disagrees with', async () => {
    // The trap this guards: `subjectKey` drops single-character tokens, so "99.9" and "99.5" both
    // reduce to `99 uptime`. Writing the preserved claim under its bare derived subject would hash
    // onto the very belief it was being kept apart from, and coalesce after all.
    readProfileMock.mockResolvedValue(existingBelief('Uptime is 99.9%', ['docA']));
    const session = await createLedgerAppendSession(LAKE);

    await session.append({
      summary: 'Uptime is 99.5%',
      evidenceTier: 'external-facing',
      sources: ['docB'],
      embedding: NEAR,
    });

    // Asserted positively: "not the other belief's subject" is also true of a plain coalesce onto
    // the stored HMAC, so it would pass even with the preservation removed.
    expect(callSubject(0)).toBe(figureScopedSubject(resolveSubject({ fact: 'Uptime is 99.5%' }), 'Uptime is 99.5%'));
    // ...and the scoping is what makes that distinct, since both facts derive the SAME bare subject.
    expect(resolveSubject({ fact: 'Uptime is 99.5%' })).toBe(resolveSubject({ fact: 'Uptime is 99.9%' }));
    expect(callSubject(0)).not.toBe(resolveSubject({ fact: 'Uptime is 99.5%' }));
  });

  it('still coalesces a restatement that carries the same figure', async () => {
    readProfileMock.mockResolvedValue(existingBelief('Uptime is 99.9%', ['docA']));
    const session = await createLedgerAppendSession(LAKE);

    await session.append({
      summary: 'The uptime is 99.90%',
      evidenceTier: 'external-facing',
      sources: ['docB'],
      embedding: NEAR,
    });

    expect(callSubject(0)).toBe('HMAC_existing');
    expect(callHashed(0)).toBe(true);
  });

  it('treats a differing figure from the SAME document as an update, not a disagreement', async () => {
    // One document re-extracted after an edit supersedes itself; only co-equal documents disagree.
    readProfileMock.mockResolvedValue(existingBelief('Headcount is 25', ['docA']));
    const session = await createLedgerAppendSession(LAKE);

    await session.append({
      summary: 'Headcount is 30',
      evidenceTier: 'external-facing',
      sources: ['docA'],
      embedding: NEAR,
    });

    expect(callSubject(0)).toBe('HMAC_existing');
  });

  it('does NOT change personal memory, where superseding is the correct behaviour', async () => {
    // The regression guard for the shared seam: this same function serves user mementos, where one
    // authority supersedes itself and replacing the older value is right.
    readProfileMock.mockResolvedValue({
      principal: { kind: 'user', id: 'user-1' },
      beliefs: [{ id: 'HMAC_existing', shredded: false, embedding: NEAR, fact: 'I run 5 miles', sources: ['s1'] }],
    });
    const session = await createLedgerAppendSession({
      principal: { kind: 'user', id: 'user-1' },
      ownerUserId: 'user-1',
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    await session.append({
      summary: 'I run 8 miles',
      evidenceTier: 'external-facing',
      sources: ['s2'],
      embedding: NEAR,
    });

    expect(callSubject(0)).toBe('HMAC_existing');
    expect(callHashed(0)).toBe(true);
  });

  it('survives a belief with no readable fact rather than throwing', async () => {
    readProfileMock.mockResolvedValue({
      principal: LAKE.principal,
      beliefs: [{ id: 'HMAC_existing', shredded: false, embedding: NEAR }],
    });
    const session = await createLedgerAppendSession(LAKE);

    await expect(
      session.append({
        summary: 'Uptime is 99.5%',
        evidenceTier: 'external-facing',
        sources: ['docB'],
        embedding: NEAR,
      })
    ).resolves.toBe(true);

    expect(callSubject(0)).toBe('HMAC_existing'); // no figures to compare -> de-dup as before
  });
});

/**
 * The single-fact user path and the crypto-shred fence.
 *
 * `writeFactToLedger` used to open its session with no `startedAt`, so the fence defaulted to the
 * moment of the WRITE. Its only caller is a background memento job that runs an LLM extraction and an
 * embedding call first, so an erase landing in that window was stamped BEFORE the default, lifted its
 * own tombstone, and the fact landed after the erase - while the job logged that the fence had
 * declined it. The fence instant must be the caller's, and must survive all the way to
 * `appendMemoryEvent`.
 */
describe('writeFactToLedger - shred fence instant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readProfileMock.mockResolvedValue(null);
    appendMemoryEventMock.mockResolvedValue({ id: 'evt-1' });
  });

  it('forwards the CALLER work-start, not the moment of the write', async () => {
    // Deliberately far in the past: a reintroduced `?? new Date()` default cannot coincide with it,
    // so this assertion fails the moment the fence stops being the caller's clock.
    const jobStartedAt = new Date('2026-03-01T00:00:00.000Z');

    await writeFactToLedger({ userId: 'u1', summary: 'the user prefers dark mode', startedAt: jobStartedAt });

    expect(appendMemoryEventMock).toHaveBeenCalledTimes(1);
    expect(appendMemoryEventMock.mock.calls[0][4].startedAt).toEqual(jobStartedAt);
  });

  it('reports a refusal as false rather than throwing, so the job is not failed for behaving', async () => {
    appendMemoryEventMock.mockResolvedValue(null);

    const written = await writeFactToLedger({
      userId: 'u1',
      summary: 'a fact extracted before the erase',
      startedAt: new Date('2026-03-01T00:00:00.000Z'),
    });

    expect(written).toBe(false);
  });
});
