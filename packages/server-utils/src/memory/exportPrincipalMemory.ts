import { HTTPError, type IMemento } from '@bike4mind/common';
import {
  activationConfigForKind,
  foldEvents,
  MEMORY_EXPORT_FORMAT_VERSION,
  type ActivationConfig,
  type Belief,
  type MemoryEvent,
  type Principal,
} from '@bike4mind/memory';
import type { KeyProvider } from './factCipher';
import { integrityError, listPrincipalLedger, type LedgerRepo } from './ledgerMemoryStore';

const MEMENTO_PAGE_SIZE = 200;
const MAX_MEMENTO_PAGES = 100;
// Under the ~6 MB buffered Lambda response limit.
const MAX_EXPORT_BYTES = 5_000_000;

const tooLarge = () => new HTTPError(413, 'Memory export is too large to download in one response.');

export interface ExportedMemento extends Omit<IMemento, 'metadata' | 'embedding' | 'embeddingModel'> {
  id: string;
  createdAt?: Date;
  updatedAt?: Date;
}

// Event and belief `subject` values are HMACs: the export is verifiable but cannot be read by subject.
export interface PrincipalMemoryExport {
  formatVersion: number;
  activation: ActivationConfig;
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
  let bytes = Buffer.byteLength(JSON.stringify(events), 'utf8');
  if (bytes > MAX_EXPORT_BYTES) throw tooLarge();
  const mementos: ExportedMemento[] = [];
  if (deps.principal.kind === 'user' && deps.mementos) {
    let afterId: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= MAX_MEMENTO_PAGES) throw tooLarge();
      const rows = await deps.mementos.findByUserId(deps.ownerUserId, { limit: MEMENTO_PAGE_SIZE, afterId });
      for (const row of rows) {
        const id = String(row.id);
        if (!id || (afterId !== undefined && id <= afterId) || row.userId !== deps.ownerUserId) {
          throw integrityError('Memory export failed integrity checks.', 'Invalid owner or cursor in memento export');
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
        const memento: ExportedMemento = {
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
        };
        bytes += Buffer.byteLength(JSON.stringify(memento), 'utf8');
        if (bytes > MAX_EXPORT_BYTES) throw tooLarge();
        mementos.push(memento);
        afterId = id;
      }
      if (rows.length < MEMENTO_PAGE_SIZE) break;
    }
  }
  const activation = activationConfigForKind(deps.principal.kind);
  const exported: PrincipalMemoryExport = {
    formatVersion: MEMORY_EXPORT_FORMAT_VERSION,
    activation,
    principal: deps.principal,
    exportedAt,
    events,
    beliefs: foldEvents(events, { now: exportedAt, activation }),
    mementos,
  };
  if (Buffer.byteLength(JSON.stringify(exported), 'utf8') > MAX_EXPORT_BYTES) throw tooLarge();
  return exported;
}
