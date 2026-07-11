import { baseApi } from '@server/middlewares/baseApi';
import {
  agentRepository,
  deepAgentCharterRepository,
  memoryLedgerRepository,
  mementoRepository,
} from '@bike4mind/database';
import { firstMatchStore, readPrincipalMemory, type PrincipalKind } from '@bike4mind/memory';
import { createDeepAgentMemoryStore } from '@server/memory/deepAgentMemoryStore';
import { createLedgerMemoryStore } from '@server/memory/ledgerMemoryStore';
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
 */
const handler = baseApi().get(async (req, res) => {
  const ownerUserId = req.user?.id;
  if (!ownerUserId) return res.status(401).json({ error: 'Authentication required' });

  const kind = String(req.query.kind);
  const id = String(req.query.id);
  if (!PRINCIPAL_KINDS.includes(kind as PrincipalKind)) {
    return res
      .status(400)
      .json({ error: `Unknown principal kind '${kind}'. Expected one of: ${PRINCIPAL_KINDS.join(', ')}.` });
  }

  // Resolve the principal against each backend, first match wins. The persisted ledger comes first,
  // so once a principal has real events they are the source of truth; a principal with no ledger
  // falls through to the snapshot adapters unchanged (DeepAgent charter, then persona-agent journal;
  // a user id via that user's own mementos). Every store is owner-scoped.
  const store = firstMatchStore([
    createLedgerMemoryStore({ ledger: memoryLedgerRepository, ownerUserId }),
    createDeepAgentMemoryStore({ charters: deepAgentCharterRepository, ownerUserId }),
    createPersonaAgentMemoryStore({ agents: agentRepository, ownerUserId }),
    createUserMementoMemoryStore({ mementos: mementoRepository, ownerUserId }),
  ]);
  const profile = await readPrincipalMemory({ kind: kind as PrincipalKind, id }, store);
  if (!profile) return res.status(404).json({ error: 'No memory found for this principal.' });

  return res.status(200).json({ profile });
});

export default handler;
