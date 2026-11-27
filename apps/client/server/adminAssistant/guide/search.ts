import type { AdminGuideEntry } from './types';

// Words that say nothing about which feature is meant: question words, request verbs, and "admin"
// and "tab", which are in nearly every question.
const STOPWORDS = new Set(
  (
    'a about admin an and are be by can configure do does explain feature for from get help how i in is it ' +
    'manage me mean my of off on or page see set show someone tab tell the there this to turn up use we what ' +
    'when where which who why with work'
  ).split(' ')
);

// A match must cover more than half the question's terms, so one shared word is not an answer.
const MIN_TERM_COVERAGE = 0.5;

// A title or keyword hit says more about the feature than a word somewhere in its steps.
const FIELD_WEIGHTS = { title: 4, keywords: 3, views: 2, summary: 1, howTo: 1, settings: 1 } as const;
type Field = keyof typeof FIELD_WEIGHTS;

// At least one term must name the feature (title or keywords), so words that only appear in its
// steps cannot make a made-up feature look like this one.
const NAMING_WEIGHT = FIELD_WEIGHTS.keywords;

// Plural, singular and verb forms count as one word: "holds" finds "hold", "banned" finds "ban",
// "delegating" finds "delegate". Only needs to be consistent: entries and queries share it.
const stem = (word: string): string => {
  let w = word;
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  w = w.replace(/([^aeiou])\1$/, '$1');
  return w.length > 4 && w.endsWith('e') ? w.slice(0, -1) : w;
};

const termsOf = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(word => word.length > 1 && !STOPWORDS.has(word))
    .map(stem);

type IndexedEntry = { entry: AdminGuideEntry; fields: Record<Field, Set<string>> };

const indexEntry = (entry: AdminGuideEntry): IndexedEntry => ({
  entry,
  fields: {
    title: new Set(termsOf(entry.title)),
    keywords: new Set(termsOf(entry.keywords.join(' '))),
    views: new Set(termsOf(entry.views.join(' '))),
    summary: new Set(termsOf(entry.summary)),
    howTo: new Set(termsOf(entry.howTo.join(' '))),
    settings: new Set(termsOf(entry.settings.join(' '))),
  },
});

// The guide is a static constant, so each one is tokenized once.
const indexCache = new WeakMap<readonly AdminGuideEntry[], IndexedEntry[]>();
const indexOf = (guide: readonly AdminGuideEntry[]): IndexedEntry[] => {
  const cached = indexCache.get(guide);
  if (cached) return cached;
  const indexed = guide.map(indexEntry);
  indexCache.set(guide, indexed);
  return indexed;
};

const termWeight = ({ fields }: IndexedEntry, term: string): number =>
  Math.max(0, ...(Object.keys(FIELD_WEIGHTS) as Field[]).filter(f => fields[f].has(term)).map(f => FIELD_WEIGHTS[f]));

const scoreOf = (indexed: IndexedEntry, terms: readonly string[]): number => {
  const weights = terms.map(term => termWeight(indexed, term));
  const covered = weights.filter(weight => weight > 0).length;
  if (covered / terms.length <= MIN_TERM_COVERAGE) return 0;
  if (!weights.some(weight => weight >= NAMING_WEIGHT)) return 0;
  return weights.reduce((sum, weight) => sum + weight, 0);
};

export type AdminGuideMatch = { entry: AdminGuideEntry; score: number };

/** The best-matching entries for a free-text question, best first; empty when nothing covers it. */
export function searchAdminGuide(guide: readonly AdminGuideEntry[], query: string, limit: number): AdminGuideMatch[] {
  const terms = [...new Set(termsOf(query))];
  if (terms.length === 0) return [];

  return indexOf(guide)
    .map(indexed => ({ entry: indexed.entry, score: scoreOf(indexed, terms) }))
    .filter(match => match.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
