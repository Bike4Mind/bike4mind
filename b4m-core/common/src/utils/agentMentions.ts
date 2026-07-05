/**
 * GitHub-style mention regex: alphanumeric + hyphens + underscores, with no
 * leading or trailing hyphen. Matches multi-word triggers like
 * `@research-lead` or `@brand-voice-writer` while rejecting `@foo-` and `@-foo`
 * so trailing punctuation in prose ("hey @bob,") doesn't end up in the handle.
 *
 * Why: `\w+` (the previous default) rejects hyphens entirely, so any agent
 * with a hyphenated trigger word was silently undiscoverable from chat. The
 * editor's typeahead already accepts hyphens, so the parser must too.
 *
 * The `(?:^|[^a-zA-Z0-9_-])` left-boundary prevents word-adjacent `@` from
 * matching: without it, `me@support.com` extracts `support`, which would
 * silently auto-attach an agent the user never mentioned (short handles
 * like `@support` or `@admin` collide with email local-part suffixes).
 *
 * Lives in `@bike4mind/common` so the chat-side parser (client) and the
 * server-side `AgentDetectionFeature` share one definition - drift between
 * the two was the original "hyphenated handles silently dropped" bug.
 */
export const MENTION_RE = /(?:^|[^a-zA-Z0-9_-])@([a-zA-Z0-9_](?:[a-zA-Z0-9_-]*[a-zA-Z0-9_])?)/g;

/**
 * Detect @-mentions in text and return lowercased mention names.
 */
export function detectAgentMentions(text: string): string[] {
  return Array.from(text.matchAll(MENTION_RE), m => m[1].toLowerCase());
}
