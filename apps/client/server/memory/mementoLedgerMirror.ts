import { memoryLedgerRepository, memoryPrincipalKeyRepository, userRepository } from '@bike4mind/database';
import {
  isExperimentalFeatureEnabled,
  MEMENTO_DEDUP_SIMILARITY,
  type HasExperimentalFeatures,
} from '@bike4mind/common';
import { cosineSimilarity, resolveSubject, type EvidenceTier, type Principal } from '@bike4mind/memory';
import { appendMemoryEvent, createLedgerMemoryStore } from './ledgerMemoryStore';
import { createKeyProvider } from './factCipher';

/**
 * The Mementos V2 WRITE seam.
 *
 * This began as a mirror - V1 persisted a memento and we copied it into the ledger - but V2 now writes
 * on its own. A V2 user's fact goes straight into their principal-scoped ledger with its own subject
 * resolution, its own semantic de-dup and its own vector, and no V1 memento is involved at all. That
 * independence is the point: it is what lets `enableMementos` be turned off today and the whole V1
 * memento pipeline be DELETED later without memory going deaf.
 *
 * While both flags are on the two still run side by side (a V2 user keeps getting V1 mementos too), so
 * a user can be flipped back with no data loss.
 */

/**
 * Per-user V2 opt-in, read from the user's experimental-features preferences. Shares one Map-aware
 * reader with the chat-completion gate (`isExperimentalFeatureEnabled`) so the read side and the
 * write side cannot drift - they disagreed once, and V2 silently captured facts it would never
 * inject.
 */
export async function isMementosV2Enabled(userId: string): Promise<boolean> {
  const user = (await userRepository.findById(userId)) as HasExperimentalFeatures | null;
  return isExperimentalFeatureEnabled(user, 'enableMementosV2');
}

/**
 * Write one extracted fact into the user's ledger as an `assert`. This is V2's OWN write path - it
 * does not require, read, or produce a V1 memento, which is what lets V1 be switched off (and one day
 * deleted) without memory going deaf.
 *
 * The fact is the LLM's summary; the evidence tier is the lowest (`engineering-proxy`) because a
 * memento is an unverified extraction. The fact and its vector are encrypted at rest under the user's
 * key, so a crypto-shred takes both.
 *
 * SUBJECT SELECTION is the whole game here, because the subject is the belief's identity: the fold
 * keys beliefs by it, so an assert on an EXISTING subject replaces that belief's content and counts as
 * another presentation of it (raising its ACT-R activation), while an assert on a NEW subject creates
 * a second belief.
 *
 * The default subject is derived from the fact's words (`resolveSubject`), which coalesces only on
 * near-identical WORDING - it is a sorted bag of tokens. That is too brittle on its own: "User's
 * favorite color is green" and "User said their favourite colour is green" are the same belief stated
 * twice, and would become two. So we first look for a semantic near-duplicate among the beliefs the
 * user already has and, if one exists, assert under ITS subject. The fact then updates in place and
 * the re-mention makes it hotter - which is exactly what a user repeating themselves should do, and
 * strictly more than V1 managed (it bumped a weight and lost the frequency signal entirely).
 */
/**
 * Write one extracted fact into an ARBITRARY principal's ledger as an `assert`. The principal-generic
 * core of the write path: `writeFactToLedger` is its user specialization, and the lake-memory producer
 * (#1440) is the other caller, writing under `{ kind: 'lake', id: datalakeTag }` owned by the lake's
 * creator. `ownerUserId` is the DEK owner (whose key encrypts the fact + vector at rest), which is a
 * user even when the principal is not - a lake's beliefs are readable only to a chat resolving that
 * owner's key, exactly as owner-scoped reads require.
 *
 * SUBJECT SELECTION is the whole game here, because the subject is the belief's identity: the fold
 * keys beliefs by it, so an assert on an EXISTING subject replaces that belief's content and counts as
 * another presentation of it (raising its ACT-R activation), while an assert on a NEW subject creates
 * a second belief. The default subject is derived from the fact's words (`resolveSubject`), a sorted
 * token bag that coalesces only on near-identical wording; when an embedding is supplied we first look
 * for a semantic near-duplicate among the principal's existing beliefs and, if one exists, assert under
 * ITS subject so the fact updates in place and the re-mention makes it hotter.
 */
export async function appendFactToLedger(params: {
  principal: Principal;
  /** DEK owner - the user whose key seals this principal's facts at rest. */
  ownerUserId: string;
  summary: string;
  evidenceTier: EvidenceTier;
  sources?: string[];
  embedding?: number[];
}): Promise<void> {
  const derivedSubject = resolveSubject({ fact: params.summary });
  if (!derivedSubject) return; // nothing to key on (content-free summary)

  const keys = createKeyProvider(memoryPrincipalKeyRepository);
  const existing = params.embedding?.length
    ? await findExistingSubject(params.principal, params.ownerUserId, keys, params.embedding)
    : null;

  await appendMemoryEvent(
    memoryLedgerRepository,
    keys,
    params.ownerUserId,
    {
      principal: params.principal,
      kind: 'assert',
      subject: existing ?? derivedSubject,
      fact: params.summary,
      evidenceTier: params.evidenceTier,
      at: new Date().toISOString(),
      sources: params.sources,
      embedding: params.embedding,
    },
    // A subject recovered from an existing belief is ALREADY the HMAC (the ledger never stores it in
    // plaintext), so it must not be hashed a second time - that would key the assert to nothing and
    // duplicate the belief instead of coalescing it. A freshly derived subject is plaintext and does
    // need hashing.
    { subjectIsHashed: existing !== null }
  );
}

/**
 * Write one extracted fact into the user's ledger as an `assert`. This is V2's OWN write path - it
 * does not require, read, or produce a V1 memento, which is what lets V1 be switched off (and one day
 * deleted) without memory going deaf.
 *
 * The fact is the LLM's summary; the evidence tier is the lowest (`engineering-proxy`) because a
 * memento is an unverified extraction. The fact and its vector are encrypted at rest under the user's
 * key, so a crypto-shred takes both. Thin user specialization of `appendFactToLedger`.
 */
export async function writeFactToLedger(params: {
  userId: string;
  summary: string;
  sources?: string[];
  embedding?: number[];
}): Promise<void> {
  return appendFactToLedger({
    principal: { kind: 'user', id: params.userId },
    ownerUserId: params.userId,
    summary: params.summary,
    evidenceTier: 'engineering-proxy',
    sources: params.sources,
    embedding: params.embedding,
  });
}

/**
 * The subject of the principal's existing belief that this fact is a restatement of, or null if it is
 * new.
 *
 * Compares against the LEDGER's own beliefs only - not the V1 union. A V1 memento's belief id is a
 * Mongo id, not a subject key, so asserting under it would mint a belief the fold can never coalesce.
 * The read path already de-dups the union by fact text, and legacy mementos age out.
 *
 * Returns the belief's id, which IS its subject - and note that the ledger stores subjects HMAC'd, so
 * what comes back is the HASH. The caller must pass it to `appendMemoryEvent` with
 * `subjectIsHashed`, or it gets hashed twice and coalesces with nothing.
 *
 * Best-effort: if the ledger cannot be read, fall back to a fresh subject. A duplicate belief is a
 * cosmetic loss; failing the write would lose the fact entirely. The failure is LOGGED rather than
 * swallowed silently - a de-dup that has quietly stopped working looks exactly like a user who repeats
 * themselves a lot, which is to say it looks like nothing at all.
 */
async function findExistingSubject(
  principal: Principal,
  ownerUserId: string,
  keys: ReturnType<typeof createKeyProvider>,
  embedding: number[]
): Promise<string | null> {
  try {
    const store = createLedgerMemoryStore({ ledger: memoryLedgerRepository, keys, ownerUserId });
    const profile = await store.readProfile(principal);
    if (!profile) return null;

    let best: { subject: string; similarity: number } | null = null;
    for (const belief of profile.beliefs) {
      if (belief.shredded || !belief.embedding?.length) continue;
      const similarity = cosineSimilarity(embedding, belief.embedding);
      if (similarity >= MEMENTO_DEDUP_SIMILARITY && (!best || similarity > best.similarity)) {
        best = { subject: belief.id, similarity }; // the fold keys beliefs BY subject, so id IS subject
      }
    }
    return best?.subject ?? null;
  } catch (error) {
    console.warn(
      `[Mementos V2] de-dup lookup failed; this fact may be stored as a duplicate belief: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  }
}
