import type { AdminErasureCollection } from '@bike4mind/common';
import { DATA_HOLDER_REGISTRY } from './registry';
import { valuesAt } from './documentPaths';
import {
  PARENT_KEY_BATCH,
  SubjectMatcher,
  orderParentsFirst,
  parentKeyPaths,
  readDocuments,
  type DataSubject,
  type LeanDocument,
} from './subjectMatcher';
import type { DataHolder, DataHolderRegistry, UserReference } from './types';

/**
 * What the data holder registry says an erasure does to each document naming a person, per the
 * rules in `types.ts`: deleted, the person removed (anonymized or pulled from an array), or kept with
 * the reason. Read only: it is the admin dry run, and the check after the account purge that records
 * what still names the person. The purge (completeAccountDeletion.ts) does the erasing.
 *
 * Reads include soft-deleted rows, since erasure must reach tombstones too. Decisions are made parents
 * first, so each `viaParent` child knows what happens to its parent. The subject's own `User` row is
 * counted as deleted.
 */

type Outcome = 'deleted' | 'anonymized' | 'retained';

type Decision = {
  outcome: Outcome;
  reasons: readonly string[];
  /** The values `viaParent` children match on, by parent key path; only on a parent model. */
  keys?: ReadonlyMap<string, readonly unknown[]>;
};

// Parent key values by path, keyed by their string form; the stored form is kept for the `$in`.
type KeysByPath = Map<string, Map<string, unknown>>;
type ParentKeys = Record<Outcome, KeysByPath>;

/** Called before each model; throw to stop (a lost purge lease). */
export type ErasureCheckpoint = () => Promise<void>;

const keptWithParentReason = (parent: string) => `Kept with its ${parent} record`;

export class SubjectErasurePlan {
  private readonly matcher: SubjectMatcher;
  private readonly models: readonly string[];
  private readonly keyPathsByParent: Map<string, Set<string>>;

  constructor(
    subject: DataSubject,
    private readonly registry: DataHolderRegistry = DATA_HOLDER_REGISTRY
  ) {
    this.matcher = new SubjectMatcher(subject);
    this.models = orderParentsFirst(registry);
    this.keyPathsByParent = parentKeyPaths(registry);
  }

  /** Per collection with any document naming the person, sorted by model name. */
  async collections(checkpoint?: ErasureCheckpoint): Promise<AdminErasureCollection[]> {
    const parentKeys = new Map<string, ParentKeys>();
    const collections: AdminErasureCollection[] = [];
    for (const model of this.models) {
      await checkpoint?.();
      const decisions = await this.decideModel(model, this.registry[model], parentKeys);
      this.rememberParentKeys(model, decisions, parentKeys);
      if (decisions.length > 0) collections.push(summarise(model, decisions));
    }
    return collections.sort((a, b) => a.model.localeCompare(b.model));
  }

  private async decideModel(
    model: string,
    holder: DataHolder,
    parentKeys: Map<string, ParentKeys>
  ): Promise<Decision[]> {
    if (holder.kind === 'subject') return this.decideSubject(model, holder.references);
    if (holder.kind === 'holder') return this.decideHolder(model, holder.references);
    if (holder.kind === 'viaParent') return this.decideChildren(model, holder, parentKeys);
    return [];
  }

  private async decideSubject(model: string, references: readonly UserReference[]): Promise<Decision[]> {
    const { userId } = this.matcher.subject;
    const decisions: Decision[] = [];
    for await (const document of readDocuments(model, { _id: userId }, { includeDeleted: true })) {
      decisions.push(this.keyed(model, document, { outcome: 'deleted', reasons: [] }));
    }
    // Their references on other people's User rows (who invited whom).
    const others = await this.decideHolder(model, references, document => String(document._id) !== userId);
    return [...decisions, ...others];
  }

  private async decideHolder(
    model: string,
    references: readonly UserReference[],
    include: (document: LeanDocument) => boolean = () => true
  ): Promise<Decision[]> {
    const clauses = references.flatMap(reference => this.matcher.filterFor(reference) ?? []);
    if (clauses.length === 0) return [];
    const decisions: Decision[] = [];
    for await (const document of readDocuments(model, { $or: clauses }, { includeDeleted: true })) {
      if (!include(document)) continue;
      const decision = this.decideDocument(document, references);
      if (decision) decisions.push(this.keyed(model, document, decision));
    }
    return decisions;
  }

  /** The precedence in `types.ts`: retain, then deleteDocument, then pull and anonymize. */
  private decideDocument(document: LeanDocument, references: readonly UserReference[]): Decision | null {
    const matched = references.filter(reference => this.matcher.matches(document, reference));
    if (matched.length === 0) return null;
    const reasons = [
      ...new Set(matched.flatMap(reference => (reference.action === 'retain' ? [reference.reason] : []))),
    ];
    if (reasons.length > 0) return { outcome: 'retained', reasons };
    if (matched.some(({ action }) => action === 'deleteDocument')) return { outcome: 'deleted', reasons: [] };
    return { outcome: 'anonymized', reasons: [] };
  }

  private async decideChildren(
    model: string,
    holder: Extract<DataHolder, { kind: 'viaParent' }>,
    parentKeys: Map<string, ParentKeys>
  ): Promise<Decision[]> {
    const keyPath = holder.parentKey ?? '_id';
    const keys = parentKeys.get(holder.parent);
    const keysFor = (outcome: Outcome) => keys?.[outcome].get(keyPath) ?? new Map<string, unknown>();
    const deletedParents = keysFor('deleted');
    const anonymizedParents = keysFor('anonymized');
    const retainedParents = keysFor('retained');
    const attribution = holder.attribution ?? [];

    const byId = new Map<string, LeanDocument>();
    const parentValues = [deletedParents, anonymizedParents, retainedParents].flatMap(map => [...map.values()]);
    for (let start = 0; start < parentValues.length; start += PARENT_KEY_BATCH) {
      const filter = { [holder.foreignKey]: { $in: parentValues.slice(start, start + PARENT_KEY_BATCH) } };
      for await (const document of readDocuments(model, filter, { includeDeleted: true })) {
        byId.set(String(document._id), document);
      }
    }
    const clauses = attribution.flatMap(reference => this.matcher.filterFor(reference) ?? []);
    if (clauses.length > 0) {
      for await (const document of readDocuments(model, { $or: clauses }, { includeDeleted: true })) {
        byId.set(String(document._id), document);
      }
    }

    const decisions: Decision[] = [];
    for (const document of byId.values()) {
      const parents = valuesAt(document, holder.foreignKey).map(String);
      const under = (map: Map<string, unknown>) => parents.some(parent => map.has(parent));
      if (under(deletedParents) || (holder.deleteWhenParentAnonymized && under(anonymizedParents))) {
        decisions.push(this.keyed(model, document, { outcome: 'deleted', reasons: [] }));
        continue;
      }
      const attributed = this.decideDocument(document, attribution);
      if (attributed) {
        decisions.push(this.keyed(model, document, attributed));
        continue;
      }
      if (under(retainedParents)) {
        const reasons = [keptWithParentReason(holder.parent)];
        decisions.push(this.keyed(model, document, { outcome: 'retained', reasons }));
      }
    }
    return decisions;
  }

  /** Records, on a parent model's decision, the values its children will be matched by. */
  private keyed(model: string, document: LeanDocument, decision: Decision): Decision {
    const keyPaths = this.keyPathsByParent.get(model);
    if (!keyPaths) return decision;
    const keys = new Map<string, unknown[]>();
    for (const keyPath of keyPaths)
      keys.set(
        keyPath,
        valuesAt(document, keyPath).filter(value => value != null)
      );
    return { ...decision, keys };
  }

  private rememberParentKeys(model: string, decisions: readonly Decision[], parentKeys: Map<string, ParentKeys>) {
    if (!this.keyPathsByParent.has(model)) return;
    const keys: ParentKeys = { deleted: new Map(), anonymized: new Map(), retained: new Map() };
    parentKeys.set(model, keys);
    for (const decision of decisions) {
      for (const [keyPath, values] of decision.keys ?? []) {
        const bucket = keys[decision.outcome].get(keyPath) ?? new Map<string, unknown>();
        for (const value of values) bucket.set(String(value), value);
        keys[decision.outcome].set(keyPath, bucket);
      }
    }
  }
}

function summarise(model: string, decisions: readonly Decision[]): AdminErasureCollection {
  const count = (outcome: Outcome) => decisions.filter(decision => decision.outcome === outcome).length;
  return {
    model,
    deleted: count('deleted'),
    anonymized: count('anonymized'),
    retained: count('retained'),
    retainReasons: [...new Set(decisions.flatMap(decision => decision.reasons))],
  };
}

/** What still names the person and is not kept by a registry reason: the purge's unfinished part. */
export const unerased = (collections: readonly AdminErasureCollection[]): AdminErasureCollection[] =>
  collections.filter(({ deleted, anonymized }) => deleted + anonymized > 0);
