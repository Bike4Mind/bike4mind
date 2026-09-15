/**
 * Shared, dependency-free text normalization used by recall (query/fact overlap) and subject
 * resolution (deriving a stable key from a fact). Kept in one place so the two agree on what a
 * "token" is - if they drifted, a fact could recall differently than it coalesces.
 */

export const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'is',
  'are',
  'was',
  'were',
  'be',
  'to',
  'of',
  'in',
  'on',
  'for',
  'and',
  'or',
  'with',
  'as',
  'at',
  'by',
  'it',
  'this',
  'that',
  'i',
  'you',
  'my',
  'me',
]);

/** Lowercase, strip punctuation, split on whitespace, drop stopwords and single characters. */
export const tokenize = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOPWORDS.has(t));
