import { mongoose } from '@bike4mind/database';
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

/** Keys of exported parents, by the parent field the children match on. */
type ParentKeys = { owned: Map<string, Map<string, unknown>>; anonymized: Map<string, Map<string, unknown>> };

/** The person is a party to the record (it is theirs, or kept about them), not only its actor. */
const isParty = (reference: UserReference): boolean =>
  reference.action === 'deleteDocument' || (reference.action === 'retain' && reference.exportScope !== 'reference');

/** The reference and every field beside it that describes the person it names. */
const personPathsOf = (reference: UserReference): readonly string[] => [
  reference.path,
  ...(reference.action === 'anonymize' || reference.action === 'retain' ? (reference.alsoRedact ?? []) : []),
  ...(reference.identifies ?? []),
];

const isExported = (holder: DataHolder): boolean =>
  holder.kind === 'subject' || holder.kind === 'holder' || holder.kind === 'viaParent';

const secretPathsOf = (holder: DataHolder): readonly string[] =>
  holder.kind === 'subject' || holder.kind === 'holder' || holder.kind === 'viaParent'
    ? (holder.secretPaths ?? [])
    : [];

export class SubjectRecordExport {
  /** Exported models in an order that puts every `viaParent` child after its parent. */
  readonly models: readonly string[];
  private readonly keyPathsByParent = new Map<string, Set<string>>();
  private readonly parentKeys = new Map<string, ParentKeys>();
  private readonly completed = new Set<string>();

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
        ? this.subjectRecords(model)
        : holder.kind === 'holder'
          ? this.holderRecords(model, holder.references)
          : holder.kind === 'viaParent'
            ? this.childRecords(model, holder)
            : null;
    if (!source) return;
    const secrets = secretPathsOf(holder);
    for await (const record of source) {
      for (const secret of secrets) omitPath(record, secret);
      yield record;
    }
    this.completed.add(model);
  }

  private async *subjectRecords(model: string): AsyncGenerator<ExportedRecord> {
    // The subject's own references sit on OTHER people's User documents (who invited whom), which
    // are not this person's to take, so only their own document is exported.
    for await (const document of this.query(model, { _id: this.subject.userId })) yield document;
  }

  private async *holderRecords(model: string, references: readonly UserReference[]): AsyncGenerator<ExportedRecord> {
    const clauses = references.flatMap(reference => this.filterFor(reference) ?? []);
    if (clauses.length === 0) return;
    for await (const document of this.query(model, { $or: clauses })) {
      const matched = references.filter(reference => this.matches(document, reference));
      if (matched.some(isParty)) {
        const owns = matched.some(({ action }) => action === 'deleteDocument' || action === 'retain');
        this.rememberParentKeys(model, document, owns);
        yield this.withholdOthers(document, references);
        continue;
      }
      if (matched.some(({ action }) => action !== 'pullFromArray')) this.rememberParentKeys(model, document, false);
      const record = this.referenceRecord(document, matched);
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
    const keyPath = holder.parentKey ?? '_id';
    const keys = this.parentKeys.get(holder.parent);
    const parentValues = [
      ...(keys?.owned.get(keyPath)?.values() ?? []),
      ...(holder.deleteWhenParentAnonymized ? (keys?.anonymized.get(keyPath)?.values() ?? []) : []),
    ];
    const seen = new Set<string>();
    for (let start = 0; start < parentValues.length; start += PARENT_KEY_BATCH) {
      const batch = parentValues.slice(start, start + PARENT_KEY_BATCH);
      for await (const document of this.query(model, { [holder.foreignKey]: { $in: batch } })) {
        seen.add(String(document._id));
        this.rememberParentKeys(model, document, true);
        yield this.withholdOthers(document, holder.attribution ?? []);
      }
    }
    const attribution = holder.attribution ?? [];
    const clauses = attribution.flatMap(reference => this.filterFor(reference) ?? []);
    if (clauses.length === 0) return;
    for await (const document of this.query(model, { $or: clauses })) {
      if (seen.has(String(document._id))) continue;
      if (!attribution.some(reference => this.matches(document, reference))) continue;
      this.rememberParentKeys(model, document, false);
      yield this.withholdOthers(document, attribution);
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
    const value =
      reference.matchBy === 'userId' && mongoose.isObjectIdOrHexString(expected)
        ? // A `Mixed` path is not cast by the schema and may hold either form.
          { $in: [expected, new mongoose.Types.ObjectId(expected)] }
        : expected;
    return { ...reference.where, [reference.path]: value };
  }

  private matches(document: LeanDocument, reference: UserReference): boolean {
    const expected = this.expectedValue(reference);
    if (!expected || !valuesAt(document, reference.path).some(value => String(value) === expected)) return false;
    return Object.entries(reference.where ?? {}).every(([path, wanted]) => {
      const values = valuesAt(document, path);
      return wanted === null ? values.every(value => value == null) : values.some(value => String(value) === wanted);
    });
  }

  private isSubject(reference: UserReference): (value: unknown) => boolean {
    const expected = this.expectedValue(reference);
    return value => expected !== null && String(value) === expected;
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
      if (valuesAt(document, reference.path).some(isSubject)) continue;
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

  /** The document id and only what names this person: the matched fields, or their array elements. */
  private referenceRecord(document: LeanDocument, matched: readonly UserReference[]): ExportedRecord | null {
    const record: ExportedRecord = { _id: document._id };
    let found = false;
    for (const reference of matched) {
      const match = matchingArrayElements(document, reference.path, this.isSubject(reference));
      if (match) {
        if (match.elements.length === 0) continue;
        const already = valuesAt(record, match.arrayPath);
        setPath(record, match.arrayPath, [...already, ...match.elements.filter(element => !already.includes(element))]);
        found = true;
        continue;
      }
      for (const path of personPathsOf(reference)) {
        const values = valuesAt(document, path);
        if (values.length > 0) setPath(record, path, values.length === 1 ? values[0] : values);
      }
      found = true;
    }
    return found ? record : null;
  }

  private rememberParentKeys(model: string, document: LeanDocument, owns: boolean): void {
    const keyPaths = this.keyPathsByParent.get(model);
    if (!keyPaths) return;
    const keys = this.parentKeys.get(model) ?? { owned: new Map(), anonymized: new Map() };
    this.parentKeys.set(model, keys);
    const bucket = owns ? keys.owned : keys.anonymized;
    for (const keyPath of keyPaths) {
      const values = bucket.get(keyPath) ?? new Map<string, unknown>();
      for (const value of valuesAt(document, keyPath)) if (value != null) values.set(String(value), value);
      bucket.set(keyPath, values);
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
