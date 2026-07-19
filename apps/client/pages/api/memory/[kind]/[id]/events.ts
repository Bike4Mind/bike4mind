import { baseApi } from '@server/middlewares/baseApi';
import { memoryLedgerRepository, memoryPrincipalKeyRepository } from '@bike4mind/database';
import {
  EVIDENCE_TIERS,
  resolveSubject,
  type EvidenceTier,
  type MemoryEventInput,
  type PrincipalKind,
} from '@bike4mind/memory';
import { appendMemoryEvent } from '@server/memory/ledgerMemoryStore';
import { createKeyProvider } from '@server/memory/factCipher';

const PRINCIPAL_KINDS: readonly PrincipalKind[] = ['user', 'agent', 'org', 'system'];
const EVENT_KINDS = ['assert', 'affirm', 'retract'] as const;
type EventKind = (typeof EVENT_KINDS)[number];

/**
 * POST /api/memory/:kind/:id/events - append one event to a principal's ledger (Mementos 2.0).
 *
 * The write path onto the persisted, content-hash-chained ledger. Owner-scoped: for now a caller
 * may only append to their OWN user memory (kind=user, id=your userId); appending to agent / org /
 * system ledgers is deferred to the cross-principal witness increment. The event time is stamped by
 * the server, not the client, so it can be trusted by the ACT-R decay and the hash chain. Beliefs
 * are not written here - they are re-folded from the ledger on read.
 */
const handler = baseApi().post(async (req, res) => {
  const ownerUserId = req.user?.id;
  if (!ownerUserId) return res.status(401).json({ error: 'Authentication required' });

  const kind = String(req.query.kind);
  const id = String(req.query.id);
  if (!PRINCIPAL_KINDS.includes(kind as PrincipalKind)) {
    return res
      .status(400)
      .json({ error: `Unknown principal kind '${kind}'. Expected one of: ${PRINCIPAL_KINDS.join(', ')}.` });
  }
  if (kind !== 'user' || id !== ownerUserId) {
    return res.status(403).json({ error: 'You can only append to your own user memory for now.' });
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const eventKind = body.kind;
  if (typeof eventKind !== 'string' || !EVENT_KINDS.includes(eventKind as EventKind)) {
    return res.status(400).json({ error: `Field 'kind' must be one of: ${EVENT_KINDS.join(', ')}.` });
  }
  const fact = typeof body.fact === 'string' ? body.fact : undefined;
  // An `assert` establishes the belief's fact; without one, the fold reuses the prior fact while the
  // assert resets derivedFrom/provenance - silently discarding citations, or (with no prior belief)
  // injecting the raw subject string as the memory. Fact-less operations belong to affirm/retract.
  if (eventKind === 'assert' && (!fact || !fact.trim())) {
    return res
      .status(400)
      .json({
        error: "An 'assert' event requires a non-empty 'fact'. Use 'affirm' or 'retract' for fact-less operations.",
      });
  }
  // Subject identity: an explicit subject wins; otherwise derive a stable key from the fact so
  // re-mentions coalesce (affirm) instead of piling up. Null means neither gave a usable key.
  const subject = resolveSubject({ subject: typeof body.subject === 'string' ? body.subject : undefined, fact });
  if (!subject) {
    return res.status(400).json({ error: "Provide a 'subject', or a 'fact' with enough content to derive one." });
  }

  const evidenceTier = body.evidenceTier;
  if (evidenceTier !== undefined && !EVIDENCE_TIERS.includes(evidenceTier as EvidenceTier)) {
    return res.status(400).json({ error: `Field 'evidenceTier' must be one of: ${EVIDENCE_TIERS.join(', ')}.` });
  }
  const sources = Array.isArray(body.sources)
    ? body.sources.filter((s): s is string => typeof s === 'string')
    : undefined;

  const eventInput: MemoryEventInput = {
    principal: { kind: kind as PrincipalKind, id },
    kind: eventKind as EventKind,
    subject,
    fact,
    evidenceTier: evidenceTier as EvidenceTier | undefined,
    at: new Date().toISOString(),
    sources,
  };

  const keys = createKeyProvider(memoryPrincipalKeyRepository);
  const sealed = await appendMemoryEvent(memoryLedgerRepository, keys, ownerUserId, eventInput);
  return res.status(201).json({ event: sealed });
});

export default handler;
