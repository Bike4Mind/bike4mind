import { mongoose } from '@bike4mind/database';
import { findUnclassifiedModels } from './registry';
import { valuesAt } from './documentPaths';
import type { DataHolder, DataHolderRegistry, UserReference } from './types';

/**
 * How the registry walks (subjectRecordExport.ts, subjectErasurePlan.ts) find and recognise a
 * person: the Mongo filter for a reference, the in-process re-match that every returned document
 * must pass, and the read itself. Shared so an export and an erasure plan agree on which documents
 * name the person.
 */

export type DataSubject = { userId: string; email: string | null };
export type LeanDocument = Record<string, unknown> & { _id?: unknown };

// One registry query must not hold a walk: past this, the read fails instead of scanning on.
export const QUERY_MAX_TIME_MS = 60_000;
// Parent keys per `$in` batch when collecting `viaParent` children.
export const PARENT_KEY_BATCH = 500;

/** A model registered in this process that the registry does not classify fails the walk loudly. */
export function assertEveryModelClassified(modelNames: readonly string[]): void {
  const unclassified = findUnclassifiedModels(modelNames);
  if (unclassified.length > 0) {
    throw new Error(`Data subject walk refused: unclassified models ${unclassified.join(', ')}`);
  }
}

export class SubjectMatcher {
  constructor(readonly subject: DataSubject) {}

  expectedValue(reference: UserReference): string | null {
    return reference.matchBy === 'email' ? this.subject.email : this.subject.userId;
  }

  filterFor(reference: UserReference): Record<string, unknown> | null {
    const expected = this.expectedValue(reference);
    if (!expected) return null;
    return { ...reference.where, [reference.path]: { $in: this.storedForms(reference, expected) } };
  }

  private storedForms(reference: UserReference, expected: string): unknown[] {
    if (reference.matchBy === 'email') {
      // Exact forms keep the query on the index; a stored address in any other mixed case is missed
      // here, and the `matches` re-match compares case-insensitively.
      return [...new Set([expected, expected.toLowerCase()])];
    }
    // A `Mixed` path is not cast by the schema and may hold either form.
    return mongoose.isObjectIdOrHexString(expected) ? [expected, new mongoose.Types.ObjectId(expected)] : [expected];
  }

  matches(document: LeanDocument, reference: UserReference): boolean {
    if (!valuesAt(document, reference.path).some(this.isSubject(reference))) return false;
    return Object.entries(reference.where ?? {}).every(([path, wanted]) =>
      valuesAt(document, path).some(value => String(value) === wanted)
    );
  }

  isSubject(reference: UserReference): (value: unknown) => boolean {
    const expected = this.expectedValue(reference);
    if (expected === null) return () => false;
    if (reference.matchBy === 'email') {
      const lowered = expected.toLowerCase();
      return value => typeof value === 'string' && value.toLowerCase() === lowered;
    }
    return value => String(value) === expected;
  }
}

/**
 * Lean read through the model, so values are cast to the schema. `strictQuery: 'throw'` makes a path
 * the schema does not declare fail the read instead of being dropped from the filter, which would
 * match every document in the collection. `includeDeleted` reaches rows the soft-delete plugin hides.
 */
export function readDocuments(
  model: string,
  filter: Record<string, unknown>,
  { includeDeleted = false }: { includeDeleted?: boolean } = {}
): AsyncIterable<LeanDocument> {
  return mongoose
    .model(model)
    .find(filter)
    .setOptions({ strictQuery: 'throw', ...(includeDeleted ? { includeDeleted: true } : {}) })
    .maxTimeMS(QUERY_MAX_TIME_MS)
    .lean<LeanDocument[]>()
    .cursor();
}

const isWalked = (holder: DataHolder): boolean =>
  holder.kind === 'subject' || holder.kind === 'holder' || holder.kind === 'viaParent';

const WALK_TIER: Partial<Record<DataHolder['kind'], number>> = { subject: 0, holder: 1, viaParent: 2 };

/**
 * The models a walk visits by tier (the subject's own record, holders, then `viaParent` children),
 * within a tier by `sizeOf` then name, with every `viaParent` child after its parent. Throws on a cycle.
 */
export function orderParentsFirst(
  registry: DataHolderRegistry,
  sizeOf: (model: string) => number = () => 0
): string[] {
  const ordered: string[] = [];
  const visiting = new Set<string>();
  const visit = (model: string) => {
    if (ordered.includes(model)) return;
    if (visiting.has(model)) throw new Error(`Data holder registry has a viaParent cycle at "${model}"`);
    visiting.add(model);
    const holder = registry[model];
    if (holder?.kind === 'viaParent') visit(holder.parent);
    visiting.delete(model);
    ordered.push(model);
  };
  const walked = Object.entries(registry)
    .filter(([, holder]) => isWalked(holder))
    .map(([model, holder]) => ({ model, tier: WALK_TIER[holder.kind] ?? 0, size: sizeOf(model) }))
    .sort((a, b) => a.tier - b.tier || a.size - b.size || a.model.localeCompare(b.model));
  for (const { model } of walked) visit(model);
  return ordered;
}

/** For each parent model, the parent fields its `viaParent` children match on (`_id` by default). */
export function parentKeyPaths(registry: DataHolderRegistry): Map<string, Set<string>> {
  const paths = new Map<string, Set<string>>();
  for (const holder of Object.values(registry)) {
    if (holder.kind !== 'viaParent') continue;
    const keys = paths.get(holder.parent) ?? new Set<string>();
    keys.add(holder.parentKey ?? '_id');
    paths.set(holder.parent, keys);
  }
  return paths;
}
