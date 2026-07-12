import { memoryLedgerRepository, memoryPrincipalKeyRepository, mementoRepository } from '@bike4mind/database';
import { mergeStores, recall } from '@bike4mind/memory';
import { createKeyProvider } from './factCipher';
import { createLedgerMemoryStore } from './ledgerMemoryStore';
import { createUserMementoMemoryStore } from './userMementoMemoryStore';
import { isMementosV2Enabled } from './mementoLedgerMirror';

/** How many beliefs V2 injects into the prompt at most. */
const V2_RECALL_K = 10;

/**
 * Mementos V2 read seam for the chat/agent prompt. Injected into the chat completion service as
 * `recallMementosV2`. Returns null for a user on V1 (caller keeps the classic memento path); for a
 * V2 user it reads their unified memory (the ledger UNIONed with their legacy V1 mementos, so V2
 * surfaces existing data without a backfill), drops shredded beliefs, and recalls the top beliefs
 * for the query. Recall is lexical for now; embedding-quality retrieval is a follow-up.
 */
export async function recallMementosV2(
  userId: string,
  query: string
): Promise<{ fact: string; relevance: number }[] | null> {
  if (!(await isMementosV2Enabled(userId))) return null;

  const store = mergeStores([
    createLedgerMemoryStore({
      ledger: memoryLedgerRepository,
      keys: createKeyProvider(memoryPrincipalKeyRepository),
      ownerUserId: userId,
    }),
    createUserMementoMemoryStore({ mementos: mementoRepository, ownerUserId: userId }),
  ]);

  const profile = await store.readProfile({ kind: 'user', id: userId });
  if (!profile) return [];

  const live = profile.beliefs.filter(b => !b.shredded); // never inject shredded content
  return recall(live, query, { k: V2_RECALL_K }).map(r => ({ fact: r.belief.fact, relevance: r.relevance }));
}
