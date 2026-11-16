import type { AdminErasureCollection } from '@bike4mind/common';
import { mongoose } from '@bike4mind/database';
import { findPersonalOrganizationIds } from '@bike4mind/server-utils/users/purgeAccountContent';
import { DATA_HOLDER_REGISTRY } from './registry';
import { valuesAt } from './documentPaths';
import { DELETED_USER_NAME, DELETED_USER_OBJECT_ID, deletedUserValue } from './placeholder';
import { SubjectErasurePlan, type ErasureCheckpoint, type ErasureEntry } from './subjectErasurePlan';
import {
  MATCH_BATCH,
  SubjectMatcher,
  orderParentsFirst,
  parentKeyPaths,
  type DataSubject,
  type LeanDocument,
} from './subjectMatcher';
import type { DataHolderRegistry, UserReference } from './types';

/**
 * Carries out what SubjectErasurePlan decides for each document naming the person: deletes it,
 * anonymizes or pulls the matched references, and clears `alsoRedact` fields, per the rules in
 * `types.ts`. Writes go by `_id` through the raw collection, so Mongoose immutability and soft-delete
 * hooks do not block them and soft-deleted rows are reached. Never run it inside `withTransaction`:
 * Mongoose would join these writes to the transaction.
 *
 * A model is written as soon as it is decided, except a `viaParent` parent: its writes wait until
 * every other model is done and then run children before parents, so a run stopped part way never
 * leaves children whose parent no longer names the person (the next run could not reach them).
 *
 * Left alone: the subject's own `User` row and their personal workspaces, which `hardDeleteUser`
 * deletes (completeAccountDeletion.ts); the purge finds those workspaces by `userId` on a retry.
 */

type Operation = mongoose.mongo.AnyBulkWriteOperation;
type Update = mongoose.mongo.UpdateFilter<mongoose.mongo.Document>;
type Plain = Record<string, unknown>;

const PERSONAL_WORKSPACE_MODEL = 'Organization';

const isPlain = (value: unknown): value is Plain =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Segment indexes of `path` whose value on `document` is an array. */
function arraySegments(document: LeanDocument, segments: readonly string[]): number[] {
  const found: number[] = [];
  let values: unknown[] = [document];
  segments.forEach((segment, index) => {
    const next = values.flatMap(value => (isPlain(value) && Object.hasOwn(value, segment) ? [value[segment]] : []));
    if (next.some(Array.isArray)) found.push(index);
    values = next.flatMap(value => (Array.isArray(value) ? value : [value]));
  });
  return found;
}

/** `segments` with `$[]` after every array but the last, which gets `last` (or nothing when null). */
function positional(segments: readonly string[], arrays: readonly number[], last: string | null): string {
  const lastArray = arrays[arrays.length - 1];
  return segments
    .map((segment, index) => {
      if (!arrays.includes(index)) return segment;
      if (index !== lastArray) return `${segment}.$[]`;
      return last === null ? segment : `${segment}.${last}`;
    })
    .join('.');
}

export class SubjectErasureExecutor {
  private readonly matcher: SubjectMatcher;
  private personalWorkspaces: Promise<ReadonlySet<string>> | undefined;
  private readonly parents: ReadonlySet<string>;
  private readonly deferred = new Map<string, Operation[]>();

  constructor(
    private readonly subject: DataSubject,
    private readonly assertLease: ErasureCheckpoint,
    private readonly registry: DataHolderRegistry = DATA_HOLDER_REGISTRY
  ) {
    this.matcher = new SubjectMatcher(subject);
    this.parents = new Set(parentKeyPaths(registry).keys());
  }

  /** Erases what the registry decides and returns those decisions, counted per collection. */
  async run(): Promise<AdminErasureCollection[]> {
    this.deferred.clear();
    const plan = new SubjectErasurePlan(this.subject, this.registry);
    const collections = await plan.collections(this.assertLease, (model, entries) => this.write(model, entries));
    for (const model of orderParentsFirst(this.registry).reverse()) {
      const operations = this.deferred.get(model);
      if (operations) await this.apply(model, operations);
    }
    return collections;
  }

  private async write(model: string, entries: readonly ErasureEntry[]): Promise<void> {
    const skipped = await this.skippedIds(model);
    const operations = entries.flatMap(entry =>
      skipped.has(String(entry.document._id)) ? [] : this.operationsFor(model, entry)
    );
    if (!this.parents.has(model)) return this.apply(model, operations);
    this.deferred.set(model, [...(this.deferred.get(model) ?? []), ...operations]);
  }

  private async apply(model: string, operations: readonly Operation[]): Promise<void> {
    const database = mongoose.connection.db;
    if (!database) throw new Error('Subject erasure requires a connected database');
    const collection = database.collection(mongoose.model(model).collection.name);
    for (let start = 0; start < operations.length; start += MATCH_BATCH) {
      await this.assertLease();
      await collection.bulkWrite(operations.slice(start, start + MATCH_BATCH), { ordered: true });
    }
  }

  private async skippedIds(model: string): Promise<ReadonlySet<string>> {
    const ids = new Set<string>();
    if (this.registry[model]?.kind === 'subject') ids.add(this.subject.userId);
    if (model === PERSONAL_WORKSPACE_MODEL) {
      this.personalWorkspaces ??= findPersonalOrganizationIds(this.subject.userId).then(found => new Set(found));
      for (const id of await this.personalWorkspaces) ids.add(id);
    }
    return ids;
  }

  private operationsFor(model: string, { outcome, matched, document }: ErasureEntry): Operation[] {
    const filter = { _id: document._id } as mongoose.mongo.Filter<mongoose.mongo.Document>;
    if (outcome === 'deleted') return [{ deleteOne: { filter } }];
    return matched.flatMap(reference => {
      const write = this.updateFor(model, reference, document);
      // Built from registry paths, which no static type describes.
      return write ? [{ updateOne: { filter, update: write.update as Update, arrayFilters: write.arrayFilters } }] : [];
    });
  }

  /** One reference's update; a `retain` only clears its `alsoRedact`. */
  private updateFor(
    model: string,
    reference: UserReference,
    document: LeanDocument
  ): { update: Plain; arrayFilters?: Plain[] } | null {
    if (reference.action === 'deleteDocument') return null;
    if (reference.action === 'retain') {
      const update = compact(this.redactions(model, reference.alsoRedact ?? [], null));
      return Object.keys(update).length > 0 ? { update } : null;
    }
    const values = [...new Set(valuesAt(document, reference.path).filter(this.matcher.isSubject(reference)))];
    if (values.length === 0) return null;
    const segments = reference.path.split('.');
    const arrays = arraySegments(document, segments);
    const lastArray = arrays[arrays.length - 1];
    const remainder = lastArray === undefined ? '' : segments.slice(lastArray + 1).join('.');

    if (reference.action === 'pullFromArray') {
      if (lastArray === undefined) return null;
      const condition = remainder ? { [remainder]: { $in: values } } : { $in: values };
      return { update: { $pull: { [positional(segments.slice(0, lastArray + 1), arrays, null)]: condition } } };
    }

    const placeholder = deletedUserValue(values[0], reference.matchBy);
    if (lastArray === undefined) {
      const redactions = this.redactions(model, reference.alsoRedact ?? [], null);
      return { update: compact({ ...redactions, $set: { ...redactions.$set, [reference.path]: placeholder } }) };
    }
    // Only the elements naming the person change; `alsoRedact` under the same array goes with them.
    const arrayPrefix = segments.slice(0, lastArray + 1).join('.');
    const redactions = this.redactions(model, reference.alsoRedact ?? [], {
      arrayPrefix,
      positional: positional(segments.slice(0, lastArray + 1), arrays, '$[match]'),
    });
    return {
      update: compact({
        ...redactions,
        $set: { ...redactions.$set, [positional(segments, arrays, '$[match]')]: placeholder },
      }),
      arrayFilters: [{ [remainder ? `match.${remainder}` : 'match']: { $in: values } }],
    };
  }

  /** `alsoRedact` paths are unset, or set to a placeholder where the schema requires them. */
  private redactions(
    model: string,
    paths: readonly string[],
    element: { arrayPrefix: string; positional: string } | null
  ): { $set: Plain; $unset: Plain } {
    const $set: Plain = {};
    const $unset: Plain = {};
    const schema = mongoose.model(model).schema;
    for (const path of paths) {
      const target =
        element && path.startsWith(`${element.arrayPrefix}.`)
          ? `${element.positional}${path.slice(element.arrayPrefix.length)}`
          : path;
      const type = schema.path(path);
      if (!type?.isRequired) {
        $unset[target] = '';
      } else {
        $set[target] = type.instance === 'ObjectId' ? DELETED_USER_OBJECT_ID : DELETED_USER_NAME;
      }
    }
    return { $set, $unset };
  }
}

const compact = (update: Plain): Plain =>
  Object.fromEntries(Object.entries(update).filter(([, value]) => !isPlain(value) || Object.keys(value).length > 0));
