/**
 * Detect `/skill-name args` invocations in a chat message.
 *
 * Lives in `@bike4mind/common` so the web chat editor, the server-side
 * SkillsFeature, and the CLI share one definition. The agent-mention parser
 * has been bitten by per-surface drift before (#agentMentions); skills avoid
 * that by starting with a single source of truth.
 *
 * Match rule:
 *   - The slash must be at the start of the message or follow whitespace
 *     (so URLs like `https://x` and paths like `me/foo` are ignored).
 *   - The name is kebab-case, identical to the SkillModel `name` regex
 *     (`[a-z0-9]` + optional inner `[a-z0-9-]*` + final `[a-z0-9]`).
 *   - The name must be followed by end-of-string, whitespace, or common
 *     punctuation. This rejects `/etc/passwd` (next char `/` isn't in the
 *     allowed terminator set) while still matching prose like
 *     "can you run /summarize? thanks".
 *
 * Args for mention[i] are everything between the end of mention[i] and the
 * start of mention[i+1] (trimmed), or to end-of-message for the last one.
 */

export const SKILL_MENTION_RE = /(?:^|\s)\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?=$|[\s.,!?;:'")\]])/g;

export interface SkillMention {
  /** kebab-case skill name (without the leading slash). */
  name: string;
  /** Free-form argument text from the message, trimmed. May be empty. */
  args: string;
}

/**
 * Punctuation that's allowed AFTER a skill name as a terminator (so the regex
 * can match it in prose) but isn't part of the args. Stripped from the LEADING
 * edge of the args slice - `"/summarize? thanks"` yields `args: "thanks"`, not
 * `"? thanks"`. The trailing args themselves are preserved verbatim because the
 * user might intentionally pass punctuation as part of an arg.
 */
const LEADING_TERMINATOR_PUNCT_RE = /^[.,!?;:'")\]]+/;

export function detectSkillMentions(text: string): SkillMention[] {
  const matches = Array.from(text.matchAll(SKILL_MENTION_RE));
  return matches.map((match, i) => {
    const name = match[1];
    // match.index points at the leading boundary (whitespace or 0). The actual
    // mention text - `/name` - begins at boundary + (1 if boundary is whitespace).
    const matchStart = match.index ?? 0;
    const slashOffset = matchStart === 0 && text[0] === '/' ? 0 : 1;
    const mentionEnd = matchStart + slashOffset + 1 /* slash */ + name.length;
    const nextStart = matches[i + 1]?.index ?? text.length;
    const args = text.slice(mentionEnd, nextStart).replace(LEADING_TERMINATOR_PUNCT_RE, '').trim();
    return { name, args };
  });
}
