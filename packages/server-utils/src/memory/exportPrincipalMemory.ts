import type { IMemento } from '@bike4mind/common';
import { activationConfigForKind, foldEvents, type Belief, type MemoryEvent, type Principal } from '@bike4mind/memory';
import type { KeyProvider } from './factCipher';
import { listPrincipalLedger, type LedgerRepo } from './ledgerMemoryStore';

const MEMENTO_PAGE_SIZE = 200;
const MAX_MEMENTO_PAGES = 2_000;

export interface ExportedMemento extends Omit<IMemento, 'metadata' | 'embedding' | 'embeddingModel'> {
  id: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface PrincipalMemoryExport {
  principal: Principal;
  exportedAt: string;
  events: MemoryEvent[];
  beliefs: Belief[];
  mementos: ExportedMemento[];
}

type MementoRow = IMemento & { id: string; createdAt?: Date; updatedAt?: Date };

export async function exportPrincipalMemory(deps: {
  principal: Principal;
  ownerUserId: string;
  ledger: Pick<LedgerRepo, 'listChain'>;
  keys: Pick<KeyProvider, 'getDek'>;
  mementos?: {
    findByUserId(userId: string, options: { limit: number; afterId?: string }): Promise<MementoRow[]>;
  };
  now?: string;
}): Promise<PrincipalMemoryExport> {
  if (!deps.ownerUserId || !deps.principal.id) throw new Error('Memory export requires a principal and owner');
  if (deps.principal.kind === 'user' && deps.principal.id !== deps.ownerUserId) {
    throw new Error("Cannot export another user's memory");
  }
  if (deps.principal.kind === 'user' && !deps.mementos) {
    throw new Error('User memory export requires a memento repository');
  }
  const exportedAt = deps.now ?? new Date().toISOString();
  const events = await listPrincipalLedger(deps);
  const mementos: ExportedMemento[] = [];
  if (deps.principal.kind === 'user' && deps.mementos) {
    let afterId: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= MAX_MEMENTO_PAGES) throw new Error('Memento export exceeded page limit');
      const rows = await deps.mementos.findByUserId(deps.ownerUserId, { limit: MEMENTO_PAGE_SIZE, afterId });
      for (const row of rows) {
        const id = String(row.id);
        if (!id || (afterId !== undefined && id <= afterId) || row.userId !== deps.ownerUserId) {
          throw new Error('Invalid owner or cursor in memento export');
        }
        const {
          userId,
          sessionId,
          questId,
          type,
          tier,
          weight,
          summary,
          fullContent,
          lastAccessedAt,
          isArchived,
          tags,
          createdAt,
          updatedAt,
        } = row;
        mementos.push({
          id,
          userId,
          sessionId,
          questId,
          type,
          tier,
          weight,
          summary,
          fullContent,
          lastAccessedAt,
          isArchived,
          tags: tags ? Array.from(tags) : undefined,
          createdAt,
          updatedAt,
        });
        afterId = id;
      }
      if (rows.length < MEMENTO_PAGE_SIZE) break;
    }
  }
  return {
    principal: deps.principal,
    exportedAt,
    events,
    beliefs: foldEvents(events, { now: exportedAt, activation: activationConfigForKind(deps.principal.kind) }),
    mementos,
  };
}
