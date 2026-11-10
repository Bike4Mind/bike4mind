import { FabFile, mongoose } from '@bike4mind/database';
import { findPersonalOrganizationIds, personalFilter } from '../users/purgeAccountContent';
import { isOrganizationFile } from '../users/purgeAccountFiles';
import { holderExportScope, viaParentExportScope, type ExportScope, type ReferenceMatch } from './exportScope';
import { DATA_HOLDER_REGISTRY, findUnclassifiedModels } from './registry';
import { matchingArrayElements, omitPath, setPath, valuesAt } from './documentPaths';
import type { DataHolder, DataHolderRegistry, UserReference } from './types';

/**
 * Walks the data-holder registry and yields, model by model, the records a data subject export
 * includes, following the export rules in `types.ts`. Each document the query returns is matched
 * again against the references here, so a document that does not verifiably name this person is
 * never exported, whatever the query matched.
 */

export type DataSubject = { userId: string; email: string | null };
export type ExportedRecord = Record<string, unknown>;

type LeanDocument = Record<string, unknown> & { _id?: unknown };

// One registry query must not hold the export: past this, the model fails and is reported omitted.
const QUERY_MAX_TIME_MS = 60_000;
// Parent keys per `$in` batch when collecting `viaParent` children.
const PARENT_KEY_BATCH = 500;

/** A model registered in this process that the registry does not classify fails the export loudly. */
export function assertEveryModelClassified(modelNames: readonly string[]): void {
  const unclassified = findUnclassifiedModels(modelNames);
  if (unclassified.length > 0) {
    throw new Error(`Data subject export refused: unclassified models ${unclassified.join(', ')}`);
  }
}

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

const isExported = (holder: DataHolder): boolean =>
  holder.kind === 'subject' || holder.kind === 'holder' || holder.kind === 'viaParent';

const withheldPathsOf = (holder: DataHolder): readonly string[] => {
  if (holder.kind === 'holder') return [...(holder.secretPaths ?? []), ...(holder.withheldPaths ?? [])];
  return holder.kind === 'subject' || holder.kind === 'viaParent' ? (holder.secretPaths ?? []) : [];
};

export class SubjectRecordExport {
  /** Exported models in an order that puts every `viaParent` child after its parent. */
  readonly models: readonly string[];
  private readonly keyPathsByParent = new Map<string, Set<string>>();
  private readonly parentScopes = new Map<string, ParentScopes>();
  private readonly completed = new Set<string>();
  private personalOrganizationIds: Promise<string[]> | undefined;

  constructor(
    private readonly subject: DataSubject,
    private readonly registry: DataHolderRegistry = DATA_HOLDER_REGISTRY
  ) {
    for (const holder of Object.values(registry)) {
      if (holder.kind !== 'viaParent') continue;
      const paths = this.keyPathsByParent.get(holder.parent) ?? new Set<string>();
      paths.add(holder.parentKey ?? '_id');
      this.keyPathsByParent.set(holder.parent, paths);
    }
    this.models = orderParentsFirst(registry);
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
    for await (const document of this.query(model, { _id: this.subject.userId })) {
      yield this.withholdOthers(document, references);
    }
  }

  private async *holderRecords(model: string, references: readonly UserReference[]): AsyncGenerator<ExportedRecord> {
    const clauses = references.flatMap(reference => this.filterFor(reference) ?? []);
    if (clauses.length === 0) return;
    const personal = await this.personalDocumentIds(model, references);
    for await (const document of this.query(model, { $or: clauses })) {
      const matches = await this.matchesOn(model, document, references, personal);
      const record = this.recordFor(model, document, holderExportScope(matches), matches, references);
      if (record) yield record;
    }
  }

  private async *childRecords(
    model: string,
    holder: Extract<DataHolder, { kind: 'viaParent' }>
  ): AsyncGenerator<ExportedRecord> {
    if (!this.completed.has(holder.parent)) {
      throw new Error(`"${model}" needs its parent "${holder.parent}" exported first`);
    }
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
      for await (const document of this.query(model, { [holder.foreignKey]: { $in: batch } })) {
        seen.add(String(document._id));
        const matches = await this.matchesOn(model, document, attribution);
        const scope = viaParentExportScope(holder, parentScopeOf(document), matches);
        const record = this.recordFor(model, document, scope, matches, attribution);
        if (record) yield record;
      }
    }
    const clauses = attribution.flatMap(reference => this.filterFor(reference) ?? []);
    if (clauses.length === 0) return;
    for await (const document of this.query(model, { $or: clauses })) {
      if (seen.has(String(document._id))) continue;
      const matches = await this.matchesOn(model, document, attribution);
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

  private query(model: string, filter: Record<string, unknown>): AsyncIterable<LeanDocument> {
    // `throw` so a path the schema does not declare fails the model instead of being dropped from
    // the filter, which would match every document in the collection.
    return mongoose
      .model(model)
      .find(filter)
      .setOptions({ strictQuery: 'throw' })
      .maxTimeMS(QUERY_MAX_TIME_MS)
      .lean<LeanDocument[]>()
      .cursor();
  }

  private expectedValue(reference: UserReference): string | null {
    return reference.matchBy === 'email' ? this.subject.email : this.subject.userId;
  }

  private filterFor(reference: UserReference): Record<string, unknown> | null {
    const expected = this.expectedValue(reference);
    if (!expected) return null;
    return { ...reference.where, [reference.path]: { $in: this.storedForms(reference, expected) } };
  }

  private storedForms(reference: UserReference, expected: string): unknown[] {
    if (reference.matchBy === 'email') {
      // Exact forms keep the query on the index; a stored address in any other mixed case is missed
      // here, and the JS re-match below compares case-insensitively.
      return [...new Set([expected, expected.toLowerCase()])];
    }
    // A `Mixed` path is not cast by the schema and may hold either form.
    return mongoose.isObjectIdOrHexString(expected) ? [expected, new mongoose.Types.ObjectId(expected)] : [expected];
  }

  /**
   * Ids of the documents each `scope: 'personal'` reference may match, selected with the account
   * purge's own predicate so the export and the purge agree on what is the person's.
   */
  private async personalDocumentIds(
    model: string,
    references: readonly UserReference[]
  ): Promise<Map<UserReference, Set<string>>> {
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
      for await (const document of cursor) ids.add(String(document._id));
    }
    return personal;
  }

  /** The references that verifiably name this person on the document, whatever the query matched. */
  private async matchesOn(
    model: string,
    document: LeanDocument,
    references: readonly UserReference[],
    personal: ReadonlyMap<UserReference, ReadonlySet<string>> = new Map()
  ): Promise<ReferenceMatch[]> {
    const matches: ReferenceMatch[] = [];
    for (const reference of references) {
      if (!this.matches(document, reference)) continue;
      if (reference.scope === 'personal' && !(await this.isPersonal(model, document, personal.get(reference)))) {
        continue;
      }
      const isSubject = this.isSubject(reference);
      // A path that reaches an array in the stored document is matched element by element.
      matches.push({ reference, throughArray: matchingArrayElements(document, reference.path, isSubject) !== null });
    }
    return matches;
  }

  private async isPersonal(model: string, document: LeanDocument, ids: ReadonlySet<string> | undefined) {
    if (!ids?.has(String(document._id))) return false;
    if (model !== FabFile.modelName) return true;
    return !(await isOrganizationFile(FabFile.hydrate(document), this.subject.userId));
  }

  private matches(document: LeanDocument, reference: UserReference): boolean {
    if (!valuesAt(document, reference.path).some(this.isSubject(reference))) return false;
    return Object.entries(reference.where ?? {}).every(([path, wanted]) =>
      valuesAt(document, path).some(value => String(value) === wanted)
    );
  }

  private isSubject(reference: UserReference): (value: unknown) => boolean {
    const expected = this.expectedValue(reference);
    if (expected === null) return () => false;
    if (reference.matchBy === 'email') {
      const lowered = expected.toLowerCase();
      return value => typeof value === 'string' && value.toLowerCase() === lowered;
    }
    return value => String(value) === expected;
  }

  /** Whether the reference holds a value and none of it is this person. */
  private namesSomeoneElse(document: LeanDocument, reference: UserReference): boolean {
    const values = valuesAt(document, reference.path).filter(value => value !== null && value !== undefined);
    return values.length > 0 && !values.some(this.isSubject(reference));
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
    for (const reference of references) {
      const isSubject = this.isSubject(reference);
      const match = matchingArrayElements(document, reference.path, isSubject);
      if (match) {
        throughArray.set(match.arrayPath, valuesAt(document, match.arrayPath));
        const elements = kept.get(match.arrayPath) ?? new Set<unknown>();
        for (const element of match.elements) elements.add(element);
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
      setPath(
        document,
        arrayPath,
        elements.filter(element => mine.has(element))
      );
    }
    return document;
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
    for (const path of paths) {
      if (othersPaths.has(path)) continue;
      const arrayMatches = matches.filter(({ reference, throughArray }) => throughArray && reference.path === path);
      if (arrayMatches.length === 0) {
        const values = valuesAt(document, path);
        if (values.length > 0) setPath(record, path, values.length === 1 ? values[0] : values);
        continue;
      }
      for (const { reference } of arrayMatches) {
        const match = matchingArrayElements(document, path, this.isSubject(reference));
        if (!match || match.elements.length === 0) continue;
        const already = valuesAt(record, match.arrayPath);
        setPath(record, match.arrayPath, [...already, ...match.elements.filter(element => !already.includes(element))]);
      }
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

function orderParentsFirst(registry: DataHolderRegistry): string[] {
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
  for (const [model, holder] of Object.entries(registry).sort(([a], [b]) => a.localeCompare(b))) {
    if (isExported(holder)) visit(model);
  }
  return ordered;
}
