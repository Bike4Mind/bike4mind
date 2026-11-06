import { DATA_HOLDER_REGISTRY } from './registry';
import { matchingArrayElements, omitPath, setPath, valuesAt } from './documentPaths';
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
 * Walks the data-holder registry and yields, model by model, the records a data subject export
 * includes, following the export rules in `types.ts`. Each document the query returns is matched
 * again against the references here, so a document that does not verifiably name this person is
 * never exported, whatever the query matched.
 */

export { assertEveryModelClassified, type DataSubject } from './subjectMatcher';
export type ExportedRecord = Record<string, unknown>;

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

const secretPathsOf = (holder: DataHolder): readonly string[] =>
  holder.kind === 'subject' || holder.kind === 'holder' || holder.kind === 'viaParent'
    ? (holder.secretPaths ?? [])
    : [];

export class SubjectRecordExport {
  /** Exported models in an order that puts every `viaParent` child after its parent. */
  readonly models: readonly string[];
  private readonly keyPathsByParent: Map<string, Set<string>>;
  private readonly matcher: SubjectMatcher;
  private readonly parentKeys = new Map<string, ParentKeys>();
  private readonly completed = new Set<string>();

  constructor(
    subject: DataSubject,
    private readonly registry: DataHolderRegistry = DATA_HOLDER_REGISTRY
  ) {
    this.matcher = new SubjectMatcher(subject);
    this.keyPathsByParent = parentKeyPaths(registry);
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
    for await (const document of readDocuments(model, { _id: this.matcher.subject.userId })) yield document;
  }

  private async *holderRecords(model: string, references: readonly UserReference[]): AsyncGenerator<ExportedRecord> {
    const clauses = references.flatMap(reference => this.matcher.filterFor(reference) ?? []);
    if (clauses.length === 0) return;
    for await (const document of readDocuments(model, { $or: clauses })) {
      const matched = references.filter(reference => this.matcher.matches(document, reference));
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
      for await (const document of readDocuments(model, { [holder.foreignKey]: { $in: batch } })) {
        seen.add(String(document._id));
        this.rememberParentKeys(model, document, true);
        yield this.withholdOthers(document, holder.attribution ?? []);
      }
    }
    const attribution = holder.attribution ?? [];
    const clauses = attribution.flatMap(reference => this.matcher.filterFor(reference) ?? []);
    if (clauses.length === 0) return;
    for await (const document of readDocuments(model, { $or: clauses })) {
      if (seen.has(String(document._id))) continue;
      if (!attribution.some(reference => this.matcher.matches(document, reference))) continue;
      this.rememberParentKeys(model, document, false);
      yield this.withholdOthers(document, attribution);
    }
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
      const isSubject = this.matcher.isSubject(reference);
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
      const match = matchingArrayElements(document, reference.path, this.matcher.isSubject(reference));
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
