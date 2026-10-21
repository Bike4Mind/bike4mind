// Models write either apostrophe in contractions; built from the code point so the source stays ASCII.
const APOSTROPHE = `['${String.fromCharCode(0x2019)}]`;
const NEGATION = String.raw`(?:do(?:es)?\s*n${APOSTROPHE}?t|do(?:es)?\s+not|can${APOSTROPHE}?t|cannot|can\s+not|am\s+unable\s+to|unable\s+to|(?:am\s+)?not\s+able\s+to)`;

// Phrasings a model uses when it was asked to search but has no search tool this turn. Kept narrow
// (each names web search, browsing or the internet) so an ordinary answer never matches.
const NO_WEB_SEARCH_PATTERNS = [
  /\bno\s+(?:web\s+|internet\s+|online\s+)?search\s+tool\b/i,
  /\bweb\s+search\s+(?:tool\s+)?(?:is\s+)?(?:not\s+(?:enabled|available|connected|turned\s+on)|unavailable|disabled|off)\b/i,
  new RegExp(
    String.raw`\b${NEGATION}\s+(?:have\s+)?(?:access\s+to\s+)?(?:a\s+|the\s+|any\s+)?(?:web\s+search|web\s+browsing|internet\s+access|the\s+internet|(?:real[-\s]time|live)\s+(?:web|internet|search|data))`,
    'i'
  ),
  new RegExp(String.raw`\b${NEGATION}\s+(?:search|browse|access)\s+(?:the\s+)?(?:web|internet|online)\b`, 'i'),
];

/** True when a reply says it could not search the web because no search tool was available. */
export function replyReportsNoWebSearch(reply: string): boolean {
  return NO_WEB_SEARCH_PATTERNS.some(pattern => pattern.test(reply));
}
