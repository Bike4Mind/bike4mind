/**
 * Escape Markdown special characters AND neutralize `@` mentions to prevent
 * injection in GitHub issue titles/bodies/comments.
 *
 * GitHub auto-links `@username` and `@org/team` in issue comments and triggers
 * notifications. When the content originates from an LLM, hallucinated handles
 * could ping real users or teams. We insert a zero-width space (U+200B) after
 * each `@` to break the auto-link pattern while keeping the text readable.
 */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/`/g, '\\`')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/@/g, '@\u200B');
}
