import { FabFile, mongoose } from '@bike4mind/database';
import { findPersonalOrganizationIds, personalFilter } from '../users/purgeAccountContent';
import { findOrganizationFileIds } from '@bike4mind/server-utils/users/purgeAccountFiles';
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
// Documents matched together, so the organization-file check reads its lakes and workspaces once per batch.
export const MATCH_BATCH = 200;

const MAX_TIME_MS_EXPIRED = 50;

/**
 * A query the server stopped for running past `maxTimeMS`. Anything else (a network failure, a
 * replica set election) fails the walk, so the job is retried rather than finished incomplete.
 */
export const isServerQueryFailure = (error: unknown): boolean =>
  error instanceof mongoose.mongo.MongoServerError && error.code === MAX_TIME_MS_EXPIRED;

/** Per `scope: 'personal'` reference, the ids of the documents it may match on this model. */
export type PersonalScope = ReadonlyMap<UserReference, ReadonlySet<string>>;

/** A model registered in this process that the registry does not classify fails the walk loudly. */
export function assertEveryModelClassified(modelNames: readonly string[]): void {
  const unclassified = findUnclassifiedModels(modelNames);
  if (unclassified.length > 0) {
    throw new Error(`Data subject walk refused: unclassified models ${unclassified.join(', ')}`);
  }
}

export class SubjectMatcher {
  private personalOrganizationIds: Promise<string[]> | undefined;

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

  /**
   * Ids of the documents each `scope: 'personal'` reference may match, selected with the account
   * purge's own predicate so the export, the erasure plan and the purge agree on what is the person's.
   * A server-stopped query is passed to `onQueryFailure` and leaves that reference with no ids (none
   * at all is safer than unknown ones); without the callback, and for any other error, it throws.
   */
  async personalDocumentIds(
    model: string,
    references: readonly UserReference[],
    onQueryFailure?: (path: string, error: unknown) => void
  ): Promise<PersonalScope> {
    const personal = new Map<UserReference, Set<string>>();
    for (const reference of references) {
      if (reference.scope !== 'personal') continue;
      const ids = new Set<string>();
      personal.set(reference, ids);
      const filter = this.filterFor(reference);
      if (!filter) continue;
      this.personalOrganizationIds ??= findPersonalOrganizationIds(this.subject.userId);
      const scoped = {
        ...filter,
        ...personalFilter(this.subject.userId, await this.personalOrganizationIds, reference.path),
      };
      // The raw collection, as the purge runs it: Mongoose would cast its `''` organization id.
      const cursor = mongoose
        .model(model)
        .collection.find(scoped, { projection: { _id: 1 } })
        .maxTimeMS(QUERY_MAX_TIME_MS);
      try {
        for await (const document of cursor) ids.add(String(document._id));
      } catch (error) {
        if (!onQueryFailure || !isServerQueryFailure(error)) throw error;
        ids.clear();
        onQueryFailure(reference.path, error);
      }
    }
    return personal;
  }

  /** Of the documents a personal reference matches, the FabFiles an organization keeps. */
  async organizationFileIds(
    model: string,
    documents: readonly LeanDocument[],
    references: readonly UserReference[],
    personal: PersonalScope
  ): Promise<ReadonlySet<string>> {
    if (model !== FabFile.modelName) return new Set();
    const candidates = documents.filter(document =>
      references.some(
        reference =>
          reference.scope === 'personal' &&
          personal.get(reference)?.has(String(document._id)) &&
          this.matches(document, reference)
      )
    );
    if (candidates.length === 0) return new Set();
    return findOrganizationFileIds(
      candidates.map(document => FabFile.hydrate(document)),
      this.subject.userId
    );
  }

  /**
   * The references that verifiably name this person on the document, whatever the query matched. A
   * `scope: 'personal'` reference matches only a document in `personal` and not in
   * `organizationFiles` (`organizationFileIds`); read the document whole when `readsWholeDocument`
   * says that check needs it.
   */
  matchingReferences(
    document: LeanDocument,
    references: readonly UserReference[],
    personal: PersonalScope = new Map(),
    organizationFiles: ReadonlySet<string> = new Set()
  ): UserReference[] {
    const id = String(document._id);
    return references.filter(
      reference =>
        this.matches(document, reference) &&
        (reference.scope !== 'personal' || (personal.get(reference)?.has(id) === true && !organizationFiles.has(id)))
    );
  }
}

/** A file's personal check reads its lake membership, so a projected read would misjudge it. */
export const readsWholeDocument = (model: string, references: readonly UserReference[]): boolean =>
  model === FabFile.modelName && references.some(reference => reference.scope === 'personal');

/**
 * Lean read through the model, so values are cast to the schema. `strictQuery: 'throw'` makes a path
 * the schema does not declare fail the read instead of being dropped from the filter, which would
 * match every document in the collection. Soft-deleted rows are read too: they are still stored, so
 * an export must include them and an erasure must reach them. `projection` (paths) keeps a walk
 * from holding whole documents it only needs to classify.
 */
export function readDocuments(
  model: string,
  filter: Record<string, unknown>,
  projection?: readonly string[]
): AsyncIterable<LeanDocument> {
  return mongoose
    .model(model)
    .find(filter, projection ? projectionOf(projection) : undefined)
    .setOptions({ strictQuery: 'throw', includeDeleted: true })
    .maxTimeMS(QUERY_MAX_TIME_MS)
    .lean<LeanDocument[]>()
    .cursor();
}

/** An inclusion projection; a path under another listed path is dropped, since Mongo refuses the pair. */
function projectionOf(paths: readonly string[]): Record<string, 1> {
  const unique = [...new Set(paths)];
  const kept = unique.filter(path => !unique.some(other => other !== path && path.startsWith(`${other}.`)));
  return Object.fromEntries(kept.map(path => [path, 1]));
}

/** The paths a reference is matched by: its own and those its `where` reads. */
export const referencePathsOf = (reference: UserReference): string[] => [
  reference.path,
  ...Object.keys(reference.where ?? {}),
];

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
