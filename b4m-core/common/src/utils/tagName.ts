import { DATALAKE_TAG_PREFIX } from '../constants/dataLakes';

/**
 * One definition of "the same tag", shared by every path that has to decide whether two tag names
 * collide: the create/rename guards in tagService, the bucket attribution in
 * tagService/listFileTags, and the chip resolution in Files/Browser. It lives in common rather than
 * in tagService because client components need it too and the services barrel pulls server-only
 * code. If those sites disagree, a rename can merge two documents the UI still draws as separate,
 * or leave two the UI draws as one.
 */

/**
 * Trim only. Casing is deliberately preserved: tag documents keep whatever casing they were
 * created with, and a rename writes the name as the caller spelled it.
 */
export const normalizeTagName = (raw: string): string => raw.trim();

/**
 * toLowerCase and not toLocaleLowerCase, whose dotless-i mapping varies by runtime locale - the
 * same reasoning listFileTags spells out where it folds bucket names.
 */
export const foldTagName = (raw: string): string => normalizeTagName(raw).toLowerCase();

/**
 * True when a tag NAME sits in the lake-membership namespace. Folds case, because the writes this
 * guards match names case-insensitively - a case-sensitive guard would let a `DATALAKE:acme`
 * document through and then strip the real `datalake:acme` membership off every file.
 *
 * Deliberately NOT `isReservedTagPrefix`, which takes a lake's configured tag PREFIX and folds no
 * case on purpose (see the note in dataLakeService/fallbackLakeTags). Same rule as the local
 * `isDataLakeTag` in fabFileService/toggleTags; keep the two in sync.
 */
export const isDataLakeTagName = (raw: string): boolean => foldTagName(raw).startsWith(DATALAKE_TAG_PREFIX);

/**
 * The tag document a name stored on a FILE belongs to. An exact match wins; otherwise the name is
 * folded, and a folded candidate is returned only when exactly ONE document folds to it.
 *
 * That last condition is the whole point and it mirrors listFileTags's attribution rule, so the
 * count and the chip cannot disagree. Legacy data can hold both `Foo` and `foo` as separate
 * documents, and crediting an ambiguous name to either one is a guess: it drew a chip for a tag the
 * file did not carry, on every file carrying the other casing. Returning nothing under-reports
 * instead of inventing.
 *
 * Direction matters as much as the rule. Resolving file name -> document yields one result per name
 * the file actually stores; filtering documents by "does any of the file's names fold to this"
 * yields a chip per matching DOCUMENT, which is where the phantom came from.
 */
export const matchTagDocument = <T extends { name: string }>(name: string, docs: readonly T[]): T | undefined => {
  const folded = foldTagName(name);
  // Every exact match also folds equal, so one pass over the candidates covers both arms.
  const candidates = docs.filter(doc => foldTagName(doc.name) === folded);
  return candidates.find(doc => doc.name === name) ?? (candidates.length === 1 ? candidates[0] : undefined);
};

/**
 * The documents behind the tag names stored on one file, deduped by identity: a file carrying both
 * `Foo` and `foo` while only `foo` exists as a document resolves both names to it and must still
 * render one chip. A name no document claims is dropped, which is the whole point - see
 * matchTagDocument.
 */
export const resolveFileTagDocs = <T extends { name: string }>(
  fileTagNames: readonly string[],
  docs: readonly T[]
): T[] => {
  const matched: T[] = [];
  const seen = new Set<T>();

  for (const name of fileTagNames) {
    const doc = matchTagDocument(name, docs);
    if (!doc || seen.has(doc)) continue;
    seen.add(doc);
    matched.push(doc);
  }

  return matched;
};
