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

/** One in-memory de-dup candidate for a write session, matched by embedding cosine. */
type DedupEntry = {
  /** The value to pass as the assert's subject to coalesce with this belief. */
  subject: string;
  /** Whether `subject` is ALREADY the stored HMAC (an existing belief) or plaintext (a fresh subject). */
  subjectIsHashed: boolean;
  embedding: number[];
};

/** The best (highest-cosine) entry at or above the de-dup threshold, or null. Pure. */
function bestDedupMatch(entries: DedupEntry[], embedding: number[]): DedupEntry | null {
  let best: DedupEntry | null = null;
  let bestSimilarity = -Infinity;
  for (const entry of entries) {
    const similarity = cosineSimilarity(embedding, entry.embedding);
    if (similarity >= MEMENTO_DEDUP_SIMILARITY && similarity > bestSimilarity) {
      best = entry;
      bestSimilarity = similarity;
    }
  }
  return best;
}

/** A batched append session for one principal's ledger. See `createLedgerAppendSession`. */
export interface LedgerAppendSession {
  append(fact: {
    summary: string;
    evidenceTier: EvidenceTier;
    sources?: string[];
    embedding?: number[];
  }): Promise<void>;
}

/**
 * Open a batched write session for ONE principal's ledger. This is the principal-generic core of the V2
 * write path: `appendFactToLedger` is the single-fact convenience wrapper, `writeFactToLedger` is the
 * user specialization, and the lake-memory producer (#1440) is the batch caller, writing under
 * `{ kind: 'lake', id: datalakeTag }` owned by the lake's creator. `ownerUserId` is the DEK owner (whose
 * key seals the fact + vector at rest), which is a user even when the principal is not.
 *
 * SUBJECT SELECTION is the whole game, because the subject is the belief's identity: the fold keys
 * beliefs by it, so an assert on an EXISTING subject updates that belief in place and counts as another
 * presentation of it (raising its ACT-R activation), while an assert on a NEW subject creates a second
 * belief. The default subject is derived from the fact's words (`resolveSubject`), a sorted token bag
 * that coalesces only on near-identical wording ("favorite color is green" vs "favourite colour is
 * green" would fork into two). So when an embedding is supplied we first look for a semantic
 * near-duplicate and, if one exists, assert under ITS subject.
 *
 * WHY A SESSION rather than a per-fact function: finding that near-duplicate means reading the
 * principal's profile, which decrypts the whole append-only chain. A producer folding a data lake
 * appends hundreds of facts in a loop, so re-reading per fact is O(facts x chain) - quadratic in the
 * run, and worsening as the run's OWN writes lengthen the chain. The session reads the profile ONCE
 * (lazily, on the first fact that actually carries an embedding) and de-dups every fact against an
 * in-memory set it keeps current as it writes - so a later fact still coalesces with an earlier one from
 * the same run, exactly as the per-fact re-read used to, without re-decrypting the chain.
 *
 * Best-effort: a profile read that fails leaves the set empty and is logged, so facts still get written
 * (possibly as duplicate beliefs - a cosmetic loss, never a lost fact), mirroring the old per-fact path.
 */
export async function createLedgerAppendSession(params: {
  principal: Principal;
  /** DEK owner - the user whose key seals this principal's facts at rest. */
  ownerUserId: string;
}): Promise<LedgerAppendSession> {
  const keys = createKeyProvider(memoryPrincipalKeyRepository);
  const entries: DedupEntry[] = [];
  let profileLoaded = false;

  // Lazy: a run with no embeddings (no API key) never needs the profile, so it never pays the decrypt -
  // the same "no embedding -> no read" shortcut the single-fact path had.
  const ensureProfileLoaded = async (): Promise<void> => {
    if (profileLoaded) return;
    profileLoaded = true;
    try {
      const store = createLedgerMemoryStore({
        ledger: memoryLedgerRepository,
        keys,
        ownerUserId: params.ownerUserId,
      });
      const profile = await store.readProfile(params.principal);
      for (const belief of profile?.beliefs ?? []) {
        if (belief.shredded || !belief.embedding?.length) continue;
        // A folded belief's id IS its stored subject HMAC (subjects are never kept in plaintext), so it
        // re-asserts with subjectIsHashed to avoid a double-hash that would fork instead of coalesce.
        entries.push({ subject: belief.id, subjectIsHashed: true, embedding: belief.embedding });
      }
    } catch (error) {
      console.warn(
        `[Mementos V2] de-dup profile read failed; facts this run may store as duplicate beliefs: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  };

  return {
    async append(fact) {
      const derivedSubject = resolveSubject({ fact: fact.summary });
      if (!derivedSubject) return; // nothing to key on (content-free summary)

      let match: DedupEntry | null = null;
      if (fact.embedding?.length) {
        await ensureProfileLoaded();
        match = bestDedupMatch(entries, fact.embedding);
      }

      await appendMemoryEvent(
        memoryLedgerRepository,
        keys,
        params.ownerUserId,
        {
          principal: params.principal,
          kind: 'assert',
          subject: match ? match.subject : derivedSubject,
          fact: fact.summary,
          evidenceTier: fact.evidenceTier,
          at: new Date().toISOString(),
          sources: fact.sources,
          embedding: fact.embedding,
        },
        // Carry the matched entry's OWN flag - a match can be an existing belief (id is already the
        // stored HMAC) OR a same-run new belief (its subject is still the plaintext derived one, so it
        // must be hashed here to land on the SAME stored HMAC and coalesce). No match -> a fresh
        // plaintext subject that needs hashing. Forcing `match !== null` would store a same-run new
        // subject as if already hashed and silently fork instead of coalescing.
        { subjectIsHashed: match ? match.subjectIsHashed : false }
      );

      // Keep the in-memory set current so a later fact in this run coalesces with this one, exactly as
      // the per-fact profile re-read used to. On a coalesce the assert's embedding wins (mirrors the
      // fold), so update it; a genuinely new belief joins the set under its plaintext derived subject.
      if (fact.embedding?.length) {
        if (match) match.embedding = fact.embedding;
        else entries.push({ subject: derivedSubject, subjectIsHashed: false, embedding: fact.embedding });
      }
    },
  };
}

/**
 * Write ONE extracted fact into an arbitrary principal's ledger as an `assert` - the single-fact
 * convenience wrapper over `createLedgerAppendSession` (see there for subject-selection and de-dup).
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
  const session = await createLedgerAppendSession({ principal: params.principal, ownerUserId: params.ownerUserId });
  await session.append({
    summary: params.summary,
    evidenceTier: params.evidenceTier,
    sources: params.sources,
    embedding: params.embedding,
  });
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
