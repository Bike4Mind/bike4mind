import { memoryLedgerRepository, memoryPrincipalKeyRepository, userRepository } from '@bike4mind/database';
import { resolveSubject } from '@bike4mind/memory';
import { appendMemoryEvent } from './ledgerMemoryStore';
import { createKeyProvider } from './factCipher';

/**
 * The Mementos V2 write seam: when a user is on V2, every memento the classic pipeline persists is
 * ALSO mirrored into that user's principal-scoped ledger (Mementos 2.0). This is additive - V1
 * mementos are unchanged - so the two run side by side and a user can be flipped back to V1 with no
 * data loss. The mirror is best-effort and must never break memento creation; callers wrap it so a
 * ledger failure only warns.
 */

/** Per-user V2 opt-in, read from the user's experimental-features preferences. */
export async function isMementosV2Enabled(userId: string): Promise<boolean> {
  const user = (await userRepository.findById(userId)) as {
    experimentalFeatures?: unknown;
    preferences?: { experimentalFeatures?: unknown };
  } | null;
  // The per-user prefs live under `preferences.experimentalFeatures`; fall back to the top-level
  // field for safety.
  const read = (raw: unknown): boolean => {
    if (raw instanceof Map) return raw.get('enableMementosV2') === true;
    if (raw && typeof raw === 'object') return (raw as Record<string, unknown>).enableMementosV2 === true;
    return false;
  };
  return read(user?.preferences?.experimentalFeatures) || read(user?.experimentalFeatures);
}

/**
 * Mirror one persisted memento into the user's ledger as an `assert`. The subject is derived from
 * the summary (so re-mentions coalesce); the fact is the memento summary; the evidence tier is the
 * lowest (`engineering-proxy`) because a memento is an unverified LLM extraction. The fact is
 * encrypted at rest under the user's key, exactly like a direct ledger write.
 *
 * `embedding` is the vector the memento pipeline ALREADY computed for this summary - passing it here
 * costs nothing and makes the ledger self-sufficient for semantic recall, instead of depending on a
 * V1 memento twin to supply the vector at read time. It is encrypted under the same key as the fact.
 */
export async function mirrorMementoToLedger(params: {
  userId: string;
  summary: string;
  sources?: string[];
  embedding?: number[];
}): Promise<void> {
  const subject = resolveSubject({ fact: params.summary });
  if (!subject) return; // nothing to key on (content-free summary)
  const keys = createKeyProvider(memoryPrincipalKeyRepository);
  await appendMemoryEvent(memoryLedgerRepository, keys, params.userId, {
    principal: { kind: 'user', id: params.userId },
    kind: 'assert',
    subject,
    fact: params.summary,
    evidenceTier: 'engineering-proxy',
    at: new Date().toISOString(),
    sources: params.sources,
    embedding: params.embedding,
  });
}
