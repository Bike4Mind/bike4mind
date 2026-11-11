import { createHash } from 'node:crypto';
import { activationConfigForKind } from './activation';
import { foldEvents, verifyChain, type MemoryEvent } from './ledger';
import type { Belief, Principal } from './types';

export function verifyMemoryExport(value: {
  principal: Principal;
  exportedAt: string;
  events: MemoryEvent[];
  beliefs: Belief[];
}): { ok: boolean; error?: string } {
  if (
    !value?.principal?.id ||
    !Number.isFinite(Date.parse(value.exportedAt)) ||
    !Array.isArray(value.events) ||
    !Array.isArray(value.beliefs)
  ) {
    return { ok: false, error: 'Invalid export structure' };
  }
  for (const event of value.events) {
    if (!event || event.principal?.kind !== value.principal.kind || event.principal.id !== value.principal.id) {
      return { ok: false, error: 'Event principal mismatch' };
    }
    if (event.shredded && (event.fact !== undefined || event.salt !== undefined || event.embedding !== undefined)) {
      return { ok: false, error: 'Shredded event contains payload' };
    }
    if (!event.shredded && (event.salt === undefined || (event.kind === 'assert' && event.fact === undefined))) {
      return { ok: false, error: 'Live event is missing its committed payload' };
    }
    if (!event.shredded && event.fact === undefined) {
      const commitment = createHash('sha256').update(`${event.salt} null`).digest('hex');
      if (commitment !== event.commitment) return { ok: false, error: 'Factless event commitment mismatch' };
    }
  }
  const chain = verifyChain(value.events);
  if (!chain.ok) return { ok: false, error: `Broken chain at event ${chain.brokenAt}` };
  const expected = foldEvents(value.events, {
    now: value.exportedAt,
    activation: activationConfigForKind(value.principal.kind),
  });
  if (JSON.stringify(expected) !== JSON.stringify(value.beliefs)) {
    return { ok: false, error: 'Exported beliefs do not match the ledger fold' };
  }
  return { ok: true };
}
