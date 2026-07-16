import { baseApi } from '@server/middlewares/baseApi';
import {
  agentRepository,
  deepAgentCharterRepository,
  memoryLedgerRepository,
  memoryPrincipalKeyRepository,
  mementoRepository,
} from '@bike4mind/database';
import { firstMatchStore, mergeStores, readPrincipalMemory, recall, type PrincipalKind } from '@bike4mind/memory';
import { createDeepAgentMemoryStore } from '@server/memory/deepAgentMemoryStore';
import { createLedgerMemoryStore, purgeUserMemory, shredBelief } from '@server/memory/ledgerMemoryStore';
import { createKeyProvider } from '@server/memory/factCipher';
import { createPersonaAgentMemoryStore } from '@server/memory/personaAgentMemoryStore';
import { createUserMementoMemoryStore } from '@server/memory/userMementoMemoryStore';

const PRINCIPAL_KINDS: readonly PrincipalKind[] = ['user', 'agent', 'org', 'system'];

/**
 * GET /api/memory/:kind/:id - read a principal's unified memory profile (Mementos 2.0).
 *
 * The unified surface over the principal-scoped memory core. An agent principal folds that agent's
 * DeepAgent charter (or, failing that, its persona-agent journal); a user principal folds that
 * user's own mementos. Owner-scoped in every store (spec L6): you only see agents you own and only
 * your own user memory, and a not-found / not-owned principal returns 404 so the endpoint never
 * reveals another principal's existence. Org/system kinds 404 until their stores are wired.
 *
 * With `?q=<query>` the response also carries `recalled`: the beliefs ranked for that query by the
 * ACT-R retrieval score (activation + relevance), the read-time pull that a chat preamble would use.
 */
const handler = baseApi();

/**
 * DELETE /api/memory/:kind/:id - delete a user's memory, for real (delete my data).
 *
 * BOTH halves of what the unified read serves, because either alone is a false promise:
 * - the LEDGER is crypto-shredded: destroy the principal's data-encryption key, so every fact -
 *   including any sitting in a DB backup - becomes permanently unreadable, then clear and flag the
 *   chain. The hash chain still verifies and the beliefs fold to redactions.
 * - the V1 MEMENTOS are hard-deleted: they carry summary, full prompt and a plaintext embedding with
 *   no key to destroy, and the read UNIONS them with the ledger - so leaving them behind would hand
 *   the user's "deleted" memories straight back into the next chat prompt.
 *
 * Authenticated and owner-scoped: a caller may delete only their own user memory for now
 * (agent/org/system deletion follows the write path). Irreversible.
 */
handler.delete(async (req, res) => {
  const ownerUserId = req.user?.id;
  if (!ownerUserId) return res.status(401).json({ error: 'Authentication required' });

  const kind = String(req.query.kind);
  const id = String(req.query.id);
  if (!PRINCIPAL_KINDS.includes(kind as PrincipalKind)) {
    return res.status(400).json({ error: `Unknown principal kind '${kind}'.` });
  }
  if (kind !== 'user' || id !== ownerUserId) {
    return res.status(403).json({ error: 'You can only delete your own user memory for now.' });
  }

  // ?subject=<beliefId> shreds ONE belief (the "delete this memory" action from the V2 dashboard); no
  // subject shreds the WHOLE principal ("delete all my memory"). The belief id IS the stored subject
  // HMAC, matched directly.
  const subject = typeof req.query.subject === 'string' ? req.query.subject : undefined;
  if (subject) {
    const shredded = await shredBelief(memoryLedgerRepository, { kind: 'user', id }, id, subject);
    return res.status(200).json({ ok: true, shredded });
  }

  // Both halves, or it is not deletion: the unified read serves the ledger UNIONED with the user's
  // V1 mementos, so shredding only the ledger left every memento readable - and re-injected into the
  // next chat prompt.
  const { eventsShredded, mementosDeleted } = await purgeUserMemory(
    memoryLedgerRepository,
    createKeyProvider(memoryPrincipalKeyRepository),
    mementoRepository,
    id
  );
  return res.status(200).json({ ok: true, shredded: eventsShredded, mementosDeleted });
});

handler.get(async (req, res) => {
  const ownerUserId = req.user?.id;
  if (!ownerUserId) return res.status(401).json({ error: 'Authentication required' });

  const kind = String(req.query.kind);
  const id = String(req.query.id);
  if (!PRINCIPAL_KINDS.includes(kind as PrincipalKind)) {
    return res
      .status(400)
      .json({ error: `Unknown principal kind '${kind}'. Expected one of: ${PRINCIPAL_KINDS.join(', ')}.` });
  }

  const ledgerStore = createLedgerMemoryStore({
    ledger: memoryLedgerRepository,
    keys: createKeyProvider(memoryPrincipalKeyRepository),
    ownerUserId,
  });

  // A user's memory is the UNION of their V2 ledger and their legacy V1 mementos, so V2 surfaces
  // everything they have with no backfill (and a V1-only user, with no ledger, just sees mementos).
  // An agent principal first-matches the ledger, then its DeepAgent charter / persona journal.
  const store =
    kind === 'user'
      ? mergeStores([ledgerStore, createUserMementoMemoryStore({ mementos: mementoRepository, ownerUserId })])
      : firstMatchStore([
          ledgerStore,
          createDeepAgentMemoryStore({ charters: deepAgentCharterRepository, ownerUserId }),
          createPersonaAgentMemoryStore({ agents: agentRepository, ownerUserId }),
        ]);
  const profile = await readPrincipalMemory({ kind: kind as PrincipalKind, id }, store);
  if (!profile) return res.status(404).json({ error: 'No memory found for this principal.' });

  // Strip the embedding from each belief before serializing. A vector is 512 floats (~1MB across a
  // real user's beliefs) that no reader of this endpoint needs - and, like the /api/mementos 502, an
  // unbounded vector payload is how this route would eventually blow the Lambda response limit.
  const lean = ({ embedding: _e, ...b }: (typeof profile.beliefs)[number]) => b;
  const leanProfile = { ...profile, beliefs: profile.beliefs.map(lean) };

  const query = typeof req.query.q === 'string' ? req.query.q : undefined;
  if (query !== undefined) {
    const recalled = recall(profile.beliefs, query).map(r => ({
      belief: lean(r.belief),
      relevance: r.relevance,
      score: r.score,
    }));
    return res.status(200).json({ profile: leanProfile, query, recalled });
  }

  return res.status(200).json({ profile: leanProfile });
});

export default handler;
