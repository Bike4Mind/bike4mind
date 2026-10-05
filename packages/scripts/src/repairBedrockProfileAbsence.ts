import {
  bedrockFoundationIdOf,
  ModelRecordWrite,
  type IModelCatalogRowInput,
  type ModelRecord,
} from '@bike4mind/common';
import { modelCatalogRepository, modelDiscoveryStateRepository } from '@bike4mind/database';
import { resolveCatalogRecords } from '@bike4mind/llm-adapters';

/**
 * Must stay in sync with ABSENCE_NOTE_PREFIX in
 * b4m-core/services/src/modelDiscoveryService/lifecyclePlan.ts: it is the prefix
 * the absence protocol stamps on a graduation row.
 */
const ABSENCE_NOTE_PREFIX = 'discovery:absence@';

export interface RepairBedrockProfileAbsenceOptions {
  /** Default false: report the rows that would be appended and write nothing. */
  apply?: boolean;
  now?: Date;
  log?: (message: string) => void;
}

export interface RepairCandidate {
  modelId: string;
  /** The bare foundation id behind the profile id. */
  foundationId: string;
  /** ISO instant the graduation row carried, when the note names one. */
  graduatedAt?: string;
}

export interface RepairBedrockProfileAbsenceResult {
  candidates: RepairCandidate[];
  /** Rows appended, or that a dry run would append. */
  repaired: number;
}

const isDeprecated = (lifecycle: unknown): boolean =>
  typeof lifecycle === 'object' && lifecycle !== null && (lifecycle as { status?: unknown }).status === 'deprecated';

/** The ISO instant after the absence marker in a graduation note, if any. */
const graduatedAt = (note: string): string | undefined => {
  const at = note.lastIndexOf(ABSENCE_NOTE_PREFIX);
  if (at < 0) return undefined;
  return note.slice(at + ABSENCE_NOTE_PREFIX.length) || undefined;
};

/**
 * One-off repair for Bedrock inference-profile ids that the absence protocol
 * graduated to `deprecated` before discovery learned to sight a profile through
 * its foundation id. Appends a discovery row that owns `lifecycle` and restores
 * `active`, so the newer row outranks the graduation row on the read path
 * without deleting history. Operator rows are never part of the selector and are
 * never written.
 *
 * Idempotent: the appended row becomes the discovery row in force, its note no
 * longer matches the graduation prefix, and a second run finds nothing.
 *
 * The code fix has to be deployed first, or the next discovery run re-graduates
 * the ids.
 */
export async function repairBedrockProfileAbsence(
  options: RepairBedrockProfileAbsenceOptions = {}
): Promise<RepairBedrockProfileAbsenceResult> {
  const { apply = false, now = new Date(), log = console.log } = options;

  const rows = await modelCatalogRepository.rowsInForce(now);
  const resolved = resolveCatalogRecords(rows);

  const candidates: RepairCandidate[] = [];
  const planned: IModelCatalogRowInput[] = [];

  for (const row of rows) {
    if (row.source !== 'discovery') continue;
    if (!row.note?.includes(ABSENCE_NOTE_PREFIX)) continue;
    const foundationId = bedrockFoundationIdOf(row.modelId);
    if (foundationId === null) continue;

    const held = resolved.get(row.modelId)?.record;
    if (!held || !isDeprecated(held.lifecycle)) continue;

    const parsed = ModelRecordWrite.safeParse(held);
    if (!parsed.success) {
      log(
        `[repair-bedrock-profile-absence] skip ${row.modelId}: in-force record does not parse: ${parsed.error.message}`
      );
      continue;
    }

    const { deprecationDate: _dropped, ...lifecycle } = parsed.data.lifecycle ?? {};
    const patch: ModelRecord = { ...parsed.data, lifecycle: { ...lifecycle, status: 'active' } };
    candidates.push({ modelId: row.modelId, foundationId, graduatedAt: graduatedAt(row.note) });
    planned.push({
      modelId: row.modelId,
      source: 'discovery',
      patch,
      ownedGroups: ['lifecycle'],
      effectiveFrom: now,
      note: `discovery:absence-repair@${now.toISOString()}`,
    });
  }

  for (const candidate of candidates) {
    log(
      `[repair-bedrock-profile-absence] ${apply ? 'restoring' : 'would restore'} ${candidate.modelId} ` +
        `(foundation ${candidate.foundationId}${candidate.graduatedAt ? `, graduated ${candidate.graduatedAt}` : ''})`
    );
  }

  if (!apply) return { candidates, repaired: candidates.length };

  let repaired = 0;
  for (let index = 0; index < planned.length; index += 1) {
    const appended = await modelCatalogRepository.append(planned[index]);
    // A concurrent writer skipping the append is not a repair we made; leave the
    // state row alone so a later run retries.
    if (!appended) continue;
    repaired += 1;
    // Clear the miss streak so the next discovery run starts from zero rather
    // than re-graduating on a stale counter.
    await modelDiscoveryStateRepository.recordSighting(candidates[index].modelId, now);
  }

  log(`[repair-bedrock-profile-absence] ${apply ? 'repaired' : 'would repair'} ${repaired} model(s)`);
  return { candidates, repaired };
}
