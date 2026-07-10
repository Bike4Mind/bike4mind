import { baseApi } from '@server/middlewares/baseApi';
import { deepAgentCharterRepository } from '@bike4mind/database';
import { readPrincipalMemory, type PrincipalKind } from '@bike4mind/memory';
import { createDeepAgentMemoryStore } from '@server/memory/deepAgentMemoryStore';

const PRINCIPAL_KINDS: readonly PrincipalKind[] = ['user', 'agent', 'org', 'system'];

/**
 * GET /api/memory/:kind/:id - read a principal's unified memory profile (Mementos 2.0).
 *
 * The first surface over the principal-scoped memory core: for an agent principal it folds that
 * agent's DeepAgent charter into the shared MemoryProfile shape. Owner-scoped in the store (spec
 * L6) - you only see agents you own - and a not-found / not-owned principal both return 404 so the
 * endpoint never reveals another owner's agent. User/org/system kinds return 404 until their
 * stores are wired (build-order steps 3+).
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

  const store = createDeepAgentMemoryStore({ charters: deepAgentCharterRepository, ownerUserId });
  const profile = await readPrincipalMemory({ kind: kind as PrincipalKind, id }, store);
  if (!profile) return res.status(404).json({ error: 'No memory found for this principal.' });

  return res.status(200).json({ profile });
});

export default handler;
