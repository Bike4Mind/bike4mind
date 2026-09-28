import { DATALAKE_TAG_PREFIX, UNCATEGORIZED_TAG_SUFFIX } from '../constants/dataLakes';

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
  // Raw comparison, deliberately NOT trimmed: a whitespace-padded stored name is legacy data (both
  // write paths trim now), and letting it win the exact arm would resolve `' Foo '` to `Foo` while a
  // case pair is present. Losing the exact arm drops it instead, which under-reports rather than
  // guessing - the same direction the ambiguous-fold case takes below.
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

/**
 * One colon-separated tag segment as a reader sees it: leading capital, hyphens as spaces.
 *
 * Shared so the data lake's browse tree and its citation chips cannot drift into naming the same
 * category two ways. `treeChrome.humanizeSegment` layers its curated PREFIX_LABELS/CATEGORY_LABELS
 * over this for the top two depths and falls through to it otherwise; `DataLakeViewer` uses it
 * directly. Deliberately NOT applied by the generic Files tag browser, which shows raw user tags.
 *
 * Only the first character is cased - a segment is a slug, not a sentence, and title-casing every
 * word would mangle an acronym the author capitalized on purpose.
 */
export const humanizeTagSegment = (segment: string): string =>
  segment.charAt(0).toUpperCase() + segment.slice(1).replace(/-/g, ' ');

/**
 * The tag labels a citation chip shows under a source's filename.
 *
 * A data lake member file carries two kinds of machine-authored tag beside the user's own: the
 * `datalake:<slug>` membership meta-tag, and prefix-arm content tags built on the lake's
 * `fileTagPrefix` (`acme:legal`, and the `acme:uncategorized` placeholder that fallbackLakeTags
 * stamps on any member no other prefix tag covers). Both are internal addressing, so a chip that
 * joined raw tag names showed the reader a lake tag path - #3291.
 *
 * Namespaced names are reduced to their LAST segment and humanized through `humanizeTagSegment`,
 * which is what the DATA LAKE browse surfaces render for that same node (DataLakeViewer and
 * treeChrome's fallback arm both call it), so a category reads identically in the tree and on the
 * chip. Note the generic Files tag browser (TagCard) renders `node.segment` raw and is NOT part of
 * that guarantee - it browses arbitrary user tags, not a lake's prefix arm. Dropped entirely:
 *  - meta-tags, folding case as isDataLakeTagName does;
 *  - `UNCATEGORIZED_TAG_SUFFIX`, a membership placeholder rather than a topic - the same exclusion
 *    the database topic-ranking aggregate makes, for the same reason;
 *  - a bare `acme:`, which names no category anyone can navigate to.
 *
 * Deduped on the rendered label, because two lakes can each contribute a `legal`, and the reader
 * would see the repeat with nothing to distinguish it.
 *
 * No lake lookup: the prefix is not needed to reduce a namespaced name to its leaf, which keeps
 * this pure string work on the tags the chip builder already holds.
 */
export const citationTagLabels = (tagNames: readonly unknown[]): string[] => {
  const labels: string[] = [];
  const seen = new Set<string>();

  for (const raw of tagNames) {
    if (typeof raw !== 'string') continue;
    if (isDataLakeTagName(raw)) continue;
    const segment = normalizeTagName(raw).split(':').pop()?.trim() ?? '';
    if (!segment || segment.toLowerCase() === UNCATEGORIZED_TAG_SUFFIX) continue;
    const label = humanizeTagSegment(segment);
    const folded = label.toLowerCase();
    if (seen.has(folded)) continue;
    seen.add(folded);
    labels.push(label);
  }

  return labels;
};

/** How many labels a chip description carries before it stops reading as a hint. */
const CITATION_TAG_LABEL_LIMIT = 4;

/**
 * The `description` a citation chip renders for a source file, or undefined when nothing survives
 * (an absent description must leave the line off, not draw an empty one). Trimmed AFTER the filter
 * so a file whose only visible tags are internal does not spend its budget on dropped names.
 */
export const citationTagDescription = (tagNames: readonly unknown[]): string | undefined =>
  citationTagLabels(tagNames).slice(0, CITATION_TAG_LABEL_LIMIT).join(', ') || undefined;
