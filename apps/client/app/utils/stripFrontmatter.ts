// Opening `---` must be the first line (after an optional BOM) and the closing `---` must sit on its own line, so a `---` rule or a dashed run inside the body never ends the block early.
const FRONTMATTER_BLOCK = /^\uFEFF?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)(?:[ \t]*\r?\n)*/;

// A frontmatter line is blank, a comment, a list item, an indented continuation, or `key: value`.
const YAML_LINE = /^(?:\s*|\s+\S.*|#.*|-(?:\s.*)?|(?:"[^"]*"|'[^']*'|[\w.-]+)[ \t]*:(?:[ \t].*)?)$/;

/**
 * Removes a leading YAML frontmatter block from markdown. Returns the input unchanged when there is
 * no terminated block, or when the span between two `---` lines is prose rather than YAML (a
 * document that opens with a horizontal rule must not lose the text up to the next one).
 */
export function stripFrontmatter(content: string): string {
  const match = FRONTMATTER_BLOCK.exec(content);
  if (!match) return content;
  const body = match[1] ?? '';
  if (!body.split(/\r?\n/).every(line => YAML_LINE.test(line))) return content;
  return content.slice(match[0].length);
}
