import type { ActivationConfig } from './activation';
import { commitFact, foldEvents, verifyChain, type MemoryEvent } from './ledger';
import type { Belief, Principal } from './types';

export const MEMORY_EXPORT_FORMAT_VERSION = 1;

export function verifyMemoryExport(value: {
  formatVersion: number;
  activation: ActivationConfig;
  principal: Principal;
  exportedAt: string;
  events: MemoryEvent[];
  beliefs: Belief[];
}): { ok: boolean; error?: string } {
  if (value?.formatVersion !== undefined && value.formatVersion !== MEMORY_EXPORT_FORMAT_VERSION) {
    return { ok: false, error: `Unsupported export format version ${value.formatVersion}` };
  }
  const activation = value?.activation;
  if (
    !value?.principal?.id ||
    value.formatVersion !== MEMORY_EXPORT_FORMAT_VERSION ||
    !activation ||
    ![activation.decay, activation.floorDays, activation.hotAbove, activation.warmAbove].every(
      n => typeof n === 'number' && Number.isFinite(n)
    ) ||
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
    if (!event.shredded && event.salt !== undefined && event.fact === undefined) {
      if (commitFact(event.salt, undefined) !== event.commitment)
        return { ok: false, error: 'Factless event commitment mismatch' };
    }
  }
  const chain = verifyChain(value.events);
  if (!chain.ok) return { ok: false, error: `Broken chain at event ${chain.brokenAt}` };
  const expected = foldEvents(value.events, { now: value.exportedAt, activation });
  if (JSON.stringify(expected) !== JSON.stringify(value.beliefs)) {
    return { ok: false, error: 'Chain verified, but exported beliefs do not match the ledger fold' };
  }
  return { ok: true };
}
