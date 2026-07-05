/**
 * Pattern Recognition Constants
 * Used for detecting decisions, actions, questions, and concerns in messages
 */

export const DECISION_PATTERNS = [
  /let'?s (go with|use|implement|do)/i,
  /we(?:'ll| will) (do|use|go with)/i,
  /decided to/i,
  /agreed? (?:on|to)/i,
  /we(?:'re| are) going (?:with|to use)/i,
  /final decision is/i,
];

export const ACTION_PATTERNS = [
  /(?:I'?ll|I will|I'?m going to) (.+)/i,
  /(?:TODO|ACTION|TASK):\s*(.+)/i,
  /(?:need to|have to|must|should) (.+)/i,
  /assign(?:ed)? to (\w+)/i,
  /(\w+) will (take care of|handle|do)/i,
];

export const QUESTION_PATTERNS = [/\?$/, /^(?:what|how|why|when|where|who)/i, /(?:what about|how about)/i];

export const CONCERN_PATTERNS = [
  /concern(?:ed)? (?:about|that)/i,
  /(?:issue|problem|risk) (?:is|with)/i,
  /worried about/i,
  /not sure (?:if|about)/i,
];

export const PRIORITY_PATTERN = /\b[Pp]([0-3])\b/;

export const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'is',
  'are',
  'was',
  'were',
  'been',
  'be',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'should',
  'could',
  'can',
  'may',
  'might',
  'must',
  'this',
  'that',
  'these',
  'those',
  'i',
  'you',
  'he',
  'she',
  'it',
  'we',
  'they',
  'what',
  'which',
  'who',
  'when',
  'where',
  'why',
  'how',
  'not',
  'no',
  'yes',
]);
