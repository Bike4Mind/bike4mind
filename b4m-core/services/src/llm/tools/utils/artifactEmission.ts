/**
 * Sanitize a model-controlled title for safe, display-clean embedding in the
 * <artifact title="..."> attribute emitted by a tool. The pristine title stays in the
 * artifact JSON body (which is what the preview card renders); this attribute is only
 * used as a label/list value and for id resolution. So we strip the parse-breaking
 * characters rather than HTML-entity-encode them - entity encoding renders as
 * "&amp;"/"&lt;" gibberish wherever `metadata.title` is shown verbatim (knowledge
 * viewer list, etc.).
 *
 * - newlines/tabs -> space: the attribute regexes use `.*?`, which won't cross newlines.
 * - strip <,>: keep the tag/attribute matchers ([^>]) from breaking.
 * - straight quotes -> typographic quotes: the value matcher is [^"'], so BOTH a "
 *   and a ' (e.g. the apostrophe in "Can't") would terminate it early. A " also lets
 *   the rest of the title be read as further attributes, so a model-chosen title could
 *   inject its own type= and re-type the artifact. Typographic (curly) quotes aren't in
 *   that class, so they're parse-safe and still read naturally.
 * `&` is left as-is: it doesn't break the regexes and React renders it correctly.
 */
export function sanitizeArtifactTitle(title: string): string {
  return title
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/'/g, '\u2019') // straight apostrophe to right single quote
    .replace(/"/g, '\u201D') // straight double quote to right double quote
    .replace(/\s+/g, ' ')
    .trim();
}

// Body escapes for tool-emitted artifacts, shared with the core artifact parser.
export { escapeArtifactBodyJson, stripArtifactTagsFromRawBody } from '@bike4mind/utils/artifactParser';
