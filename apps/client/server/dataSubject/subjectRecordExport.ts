import { mongoose } from '@bike4mind/database';
import { holderExportScope, viaParentExportScope, type ExportScope, type ReferenceMatch } from './exportScope';
import { DATA_HOLDER_REGISTRY } from './registry';
import { cloneContainers, matchingArrayElements, omitPath, setPath, valuesAt } from './documentPaths';
import {
  MATCH_BATCH,
  PARENT_KEY_BATCH,
  SubjectMatcher,
  isServerQueryFailure,
  orderParentsFirst,
  parentKeyPaths,
  readDocuments,
  type DataSubject,
  type LeanDocument,
  type PersonalScope,
} from './subjectMatcher';
import type { DataHolder, DataHolderRegistry, UserReference } from './types';

/**
 * Walks the data-holder registry and yields, model by model, the records a data subject export
 * includes, following the export rules in `types.ts`. Each document the query returns is matched
 * again against the references here, so a document that does not verifiably name this person is
 * never exported, whatever the query matched.
 */

export { assertEveryModelClassified, type DataSubject } from './subjectMatcher';
export type ExportedRecord = Record<string, unknown>;

// Sizing only orders the walk, so a collection that cannot be sized quickly is just walked last in its tier.
const SIZE_MAX_TIME_MS = 2_000;
const SIZE_CONCURRENCY = 8;

/** A reference whose own query failed; the model's other references are still exported. */
export type FailedReference = { path: string; error: unknown };

/** An exported parent's key value, by its string form, with the scope the parent was exported at. */
type ParentKeys = Map<string, { value: unknown; scope: ExportScope }>;
/** Exported parents' keys, by the parent field their children match on. */
type ParentScopes = Map<string, ParentKeys>;

const NO_PARENT: ExportScope = { scope: 'none' };

/** The reference and every field beside it that describes the person it names. */
const personPathsOf = (reference: UserReference): readonly string[] => [
  reference.path,
  ...(reference.action === 'anonymize' || reference.action === 'retain' ? (reference.alsoRedact ?? []) : []),
  ...(reference.identifies ?? []),
];

/**
 * The references that read inside `arrayPath`, with every path taken relative to one of its
 * elements, so an element can be withheld from like a document of its own.
 */
function referencesWithin(references: readonly UserReference[], arrayPath: string): UserReference[] {
  const prefix = `${arrayPath}.`;
  const within = (paths: readonly string[] | undefined): string[] | undefined =>
    paths?.filter(path => path.startsWith(prefix)).map(path => path.slice(prefix.length));
  return references
    .filter(reference => reference.path.startsWith(prefix))
    .map(reference => {
      const rebased = {
        ...reference,
        path: reference.path.slice(prefix.length),
        identifies: within(reference.identifies),
      };
      return 'alsoRedact' in rebased ? { ...rebased, alsoRedact: within(rebased.alsoRedact) } : rebased;
    });
}

const isRecord = (value: unknown): value is LeanDocument =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const withheldPathsOf = (holder: DataHolder): readonly string[] => {
  if (holder.kind === 'holder') return [...(holder.secretPaths ?? []), ...(holder.withheldPaths ?? [])];
  return holder.kind === 'subject' || holder.kind === 'viaParent' ? (holder.secretPaths ?? []) : [];
};

/** Drops a cut-down part when its outer element is already kept whole (cut parts are fresh objects, so identity dedupe misses them). */
function withoutShadowedParts(elements: readonly unknown[], origins: ReadonlyMap<unknown, unknown>): unknown[] {
  const whole = new Set(elements.filter(element => origins.get(element) === element));
  return elements.filter(element => origins.get(element) === element || !whole.has(origins.get(element)));
}

export class SubjectRecordExport {
  /** Exported models in an order that puts every `viaParent` child after its parent. */
  readonly models: readonly string[];
  private readonly keyPathsByParent: Map<string, Set<string>>;
  private readonly matcher: SubjectMatcher;
  private readonly parentScopes = new Map<string, ParentScopes>();
  private readonly completed = new Set<string>();
  private readonly failures = new Map<string, FailedReference[]>();

  constructor(
    subject: DataSubject,
    private readonly registry: DataHolderRegistry = DATA_HOLDER_REGISTRY
  ) {
    this.matcher = new SubjectMatcher(subject);
    this.keyPathsByParent = parentKeyPaths(registry);
    this.models = orderParentsFirst(registry);
  }

  /**
   * `models`, with the models of each tier (own record, holders, `viaParent` children) walked
   * smallest collection first, so a few large collections cannot spend the time small ones need.
   */
  async walkOrder(): Promise<readonly string[]> {
    const sizes = new Map<string, number>();
    const pending = [...this.models];
    const sizeNext = async (): Promise<void> => {
      for (let model = pending.shift(); model; model = pending.shift()) {
        try {
          sizes.set(
            model,
            await mongoose.model(model).collection.estimatedDocumentCount({ maxTimeMS: SIZE_MAX_TIME_MS })
          );
        } catch {
          // Not logged: a failed size only moves the model to the end of its tier, and a model whose
          // reads fail is reported through `failedReferences`.
          sizes.set(model, Number.MAX_SAFE_INTEGER);
        }
      }
    };
    await Promise.all(Array.from({ length: SIZE_CONCURRENCY }, sizeNext));
    return orderParentsFirst(this.registry, model => sizes.get(model) ?? Number.MAX_SAFE_INTEGER);
  }

  /** The references of `model` whose query failed while its records were read. */
  failedReferences(model: string): readonly FailedReference[] {
    return this.failures.get(model) ?? [];
  }

  /** The model's records. A `viaParent` model must come after its parent has been fully read. */
  async *records(model: string): AsyncGenerator<ExportedRecord> {
    const holder = this.registry[model];
    if (!holder) throw new Error(`"${model}" is not in the data holder registry`);
    const source =
      holder.kind === 'subject'
        ? this.subjectRecords(model, holder.references)
        : holder.kind === 'holder'
          ? this.holderRecords(model, holder.references)
          : holder.kind === 'viaParent'
            ? this.childRecords(model, holder)
            : null;
    if (!source) return;
    this.failures.delete(model);
    const withheld = withheldPathsOf(holder);
    for await (const record of source) {
      for (const path of withheld) omitPath(record, path);
      yield record;
    }
    this.completed.add(model);
  }

  private async *subjectRecords(model: string, references: readonly UserReference[]): AsyncGenerator<ExportedRecord> {
    // The subject's own references sit on OTHER people's User documents (who invited whom), which
    // are not this person's to take, so only their own document is exported, less the people it
    // names (their referrer, the admin who throttled them).
    for await (const document of readDocuments(model, { _id: this.matcher.subject.userId })) {
      yield this.withholdOthers(document, references);
    }
  }

  private async *holderRecords(model: string, references: readonly UserReference[]): AsyncGenerator<ExportedRecord> {
    const personal = await this.matcher.personalDocumentIds(model, references, (path, error) =>
      this.recordFailure(model, path, error)
    );
    let batch: LeanDocument[] = [];
    for await (const document of this.referenceMatches(model, references)) {
      batch.push(document);
      if (batch.length < MATCH_BATCH) continue;
      yield* this.holderBatch(model, batch, references, personal);
      batch = [];
    }
    yield* this.holderBatch(model, batch, references, personal);
  }

  private async *holderBatch(
    model: string,
    documents: readonly LeanDocument[],
    references: readonly UserReference[],
    personal: PersonalScope
  ): AsyncGenerator<ExportedRecord> {
    const organizationFiles = await this.matcher.organizationFileIds(model, documents, references, personal);
    for (const document of documents) {
      const matches = this.matchesOn(document, references, personal, organizationFiles);
      const record = this.recordFor(model, document, holderExportScope(matches), matches, references);
      if (record) yield record;
    }
  }

  /**
   * Every document any reference matches, each once. Each reference is its own query, so one that
   * is slow (an unindexed path) or rejected by the server is recorded in `failedReferences` and the
   * others still export.
   */
  private async *referenceMatches(
    model: string,
    references: readonly UserReference[],
    seen = new Set<string>()
  ): AsyncGenerator<LeanDocument> {
    const queried = new Set<string>();
    for (const reference of references) {
      const filter = this.matcher.filterFor(reference);
      if (!filter) continue;
      const key = JSON.stringify(filter);
      if (queried.has(key)) continue;
      queried.add(key);
      try {
        for await (const document of readDocuments(model, filter)) {
          const id = String(document._id);
          if (seen.has(id)) continue;
          seen.add(id);
          yield document;
        }
      } catch (error) {
        if (!isServerQueryFailure(error)) throw error;
        this.recordFailure(model, reference.path, error);
      }
    }
  }

  private recordFailure(model: string, path: string, error: unknown): void {
    const failures = this.failures.get(model) ?? [];
    if (!failures.some(failure => failure.path === path)) failures.push({ path, error });
    this.failures.set(model, failures);
  }

  private async *childRecords(
    model: string,
    holder: Extract<DataHolder, { kind: 'viaParent' }>
  ): AsyncGenerator<ExportedRecord> {
    if (!this.completed.has(holder.parent)) {
      throw new Error(`"${model}" needs its parent "${holder.parent}" exported first`);
    }
    // Children of parent documents the parent's failed references missed are missed too.
    for (const { error } of this.failedReferences(holder.parent)) this.recordFailure(model, holder.foreignKey, error);
    const attribution = holder.attribution ?? [];
    const parents: ParentKeys = this.parentScopes.get(holder.parent)?.get(holder.parentKey ?? '_id') ?? new Map();
    // Only parents that bring their children along on their own; the rest can only reach a child
    // through its attribution, which the query below covers.
    const parentValues = [...parents.values()]
      .filter(({ scope }) => viaParentExportScope(holder, scope, []).scope !== 'none')
      .map(({ value }) => value);
    const parentScopeOf = (document: LeanDocument): ExportScope => {
      const scopes = valuesAt(document, holder.foreignKey).map(value => parents.get(String(value))?.scope);
      return (
        scopes.find(scope => scope?.scope === 'wholeDocument') ?? scopes.find(scope => scope !== undefined) ?? NO_PARENT
      );
    };
    const seen = new Set<string>();
    for (let start = 0; start < parentValues.length; start += PARENT_KEY_BATCH) {
      const batch = parentValues.slice(start, start + PARENT_KEY_BATCH);
      for await (const document of readDocuments(model, { [holder.foreignKey]: { $in: batch } })) {
        seen.add(String(document._id));
        const matches = this.matchesOn(document, attribution);
        const scope = viaParentExportScope(holder, parentScopeOf(document), matches);
        const record = this.recordFor(model, document, scope, matches, attribution);
        if (record) yield record;
      }
    }
    for await (const document of this.referenceMatches(model, attribution, seen)) {
      const matches = this.matchesOn(document, attribution);
      const record = this.recordFor(
        model,
        document,
        viaParentExportScope(holder, NO_PARENT, matches),
        matches,
        attribution
      );
      if (record) yield record;
    }
  }

  /** The references that verifiably name this person on the document, whatever the query matched. */
  private matchesOn(
    document: LeanDocument,
    references: readonly UserReference[],
    personal?: PersonalScope,
    organizationFiles?: ReadonlySet<string>
  ): ReferenceMatch[] {
    const matched = this.matcher.matchingReferences(document, references, personal, organizationFiles);
    // A path that reaches an array in the stored document is matched element by element.
    return matched.map(reference => ({
      reference,
      throughArray: matchingArrayElements(document, reference.path, this.matcher.isSubject(reference)) !== null,
    }));
  }

  /** Whether the reference holds a value and none of it is this person. */
  private namesSomeoneElse(document: LeanDocument, reference: UserReference): boolean {
    const values = valuesAt(document, reference.path).filter(value => value !== null && value !== undefined);
    return values.length > 0 && !values.some(this.matcher.isSubject(reference));
  }

  private recordFor(
    model: string,
    document: LeanDocument,
    scope: ExportScope,
    matches: readonly ReferenceMatch[],
    references: readonly UserReference[]
  ): ExportedRecord | null {
    if (scope.scope === 'none') return null;
    this.rememberParentScope(model, document, scope);
    return scope.scope === 'wholeDocument'
      ? this.withholdOthers(document, references)
      : this.matchedPathsRecord(document, scope.paths, matches, references);
  }

  /**
   * The document, less every other person on it: a reference naming someone else goes with the
   * fields that describe them, and an array a reference reads through keeps only this person's
   * elements.
   */
  private withholdOthers(document: LeanDocument, references: readonly UserReference[]): ExportedRecord {
    const kept = new Map<string, Set<unknown>>();
    const throughArray = new Map<string, unknown[]>();
    const origins = new Map<unknown, unknown>();
    for (const reference of references) {
      const isSubject = this.matcher.isSubject(reference);
      const match = matchingArrayElements(document, reference.path, isSubject);
      if (match) {
        throughArray.set(match.arrayPath, valuesAt(document, match.arrayPath));
        const elements = kept.get(match.arrayPath) ?? new Set<unknown>();
        match.elements.forEach((element, index) => {
          elements.add(element);
          origins.set(element, match.origins[index]);
        });
        kept.set(match.arrayPath, elements);
        continue;
      }
      // An empty `anonymize` reference names nobody, so the fields beside it describe whoever the
      // document is about (a normal session's device, not an impersonating admin's).
      const namesOther =
        reference.action === 'anonymize'
          ? this.namesSomeoneElse(document, reference)
          : !valuesAt(document, reference.path).some(isSubject);
      if (!namesOther) continue;
      for (const path of personPathsOf(reference)) omitPath(document, path);
    }
    for (const [arrayPath, elements] of throughArray) {
      const mine = kept.get(arrayPath) ?? new Set<unknown>();
      // Whole elements in stored order, then the cut-down parts of a nested array match.
      const stored = new Set(elements);
      const ordered = withoutShadowedParts(
        [...elements.filter(element => mine.has(element)), ...[...mine].filter(e => !stored.has(e))],
        origins
      );
      setPath(document, arrayPath, this.subjectElements(ordered, arrayPath, references));
    }
    return document;
  }

  /**
   * Copies of the array elements kept for this person, each less the other people the references
   * inside the array name (the reviewers' verdicts on the person's own eval-set example).
   */
  private subjectElements(
    elements: readonly unknown[],
    arrayPath: string,
    references: readonly UserReference[]
  ): unknown[] {
    const within = referencesWithin(references, arrayPath);
    if (within.length === 0) return [...elements];
    return elements.map(element => {
      const copy = cloneContainers(element);
      return isRecord(copy) ? this.withholdOthers(copy, within) : copy;
    });
  }

  /**
   * The document id and `paths`; a path matched through an array keeps only this person's elements.
   * A path that also describes someone another reference names is left out (the admin's IP on a
   * session they revoked), as `withholdOthers` does for a whole document.
   */
  private matchedPathsRecord(
    document: LeanDocument,
    paths: readonly string[],
    matches: readonly ReferenceMatch[],
    references: readonly UserReference[]
  ): ExportedRecord {
    const record: ExportedRecord = { _id: document._id };
    const matchedPaths = new Set(matches.map(({ reference }) => reference.path));
    const matched = new Set(matches.map(({ reference }) => reference));
    const othersPaths = new Set(
      references
        .filter(reference => !matched.has(reference) && this.namesSomeoneElse(document, reference))
        .flatMap(personPathsOf)
        .filter(path => !matchedPaths.has(path))
    );
    const arrayElements = new Map<string, unknown[]>();
    const origins = new Map<unknown, unknown>();
    for (const path of paths) {
      if (othersPaths.has(path)) continue;
      const arrayMatches = matches.filter(({ reference, throughArray }) => throughArray && reference.path === path);
      if (arrayMatches.length === 0) {
        const values = valuesAt(document, path);
        if (values.length > 0) setPath(record, path, values.length === 1 ? values[0] : values);
        continue;
      }
      for (const { reference } of arrayMatches) {
        const match = matchingArrayElements(document, path, this.matcher.isSubject(reference));
        if (!match || match.elements.length === 0) continue;
        const kept = arrayElements.get(match.arrayPath) ?? [];
        const seen = new Set(kept);
        match.elements.forEach((element, index) => {
          if (seen.has(element)) return;
          kept.push(element);
          origins.set(element, match.origins[index]);
        });
        arrayElements.set(match.arrayPath, kept);
      }
    }
    for (const [arrayPath, elements] of arrayElements) {
      setPath(record, arrayPath, this.subjectElements(withoutShadowedParts(elements, origins), arrayPath, references));
    }
    return record;
  }

  private rememberParentScope(model: string, document: LeanDocument, scope: ExportScope): void {
    const keyPaths = this.keyPathsByParent.get(model);
    if (!keyPaths) return;
    const byKeyPath: ParentScopes = this.parentScopes.get(model) ?? new Map();
    this.parentScopes.set(model, byKeyPath);
    for (const keyPath of keyPaths) {
      const parents: ParentKeys = byKeyPath.get(keyPath) ?? new Map();
      byKeyPath.set(keyPath, parents);
      for (const value of valuesAt(document, keyPath)) {
        if (value == null) continue;
        const key = String(value);
        if (parents.get(key)?.scope.scope === 'wholeDocument') continue;
        parents.set(key, { value, scope });
      }
    }
  }
}
