// Opening `---` must be the first line (after an optional BOM) and the closing `---` must sit on its own line, so a `---` rule or a dashed run inside the body never ends the block early.
const FRONTMATTER_BLOCK = /^\uFEFF?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)(?:[ \t]*\r?\n)*/;

const KEY_VALUE = /(?:"[^"]*"|'[^']*'|[\w.-]+)[ \t]*:(?:[ \t].*)?/;
const KEY_VALUE_LINE = new RegExp(`^${KEY_VALUE.source}$`);
// A frontmatter line is blank, a comment, a list item, an indented continuation, or `key: value`.
const YAML_LINE = new RegExp(`^(?:\\s*|\\s+\\S.*|#.*|-(?:\\s.*)?|${KEY_VALUE.source})$`);

/**
 * Removes a leading YAML frontmatter block from markdown. Returns the input unchanged when there is
 * no terminated block, or when the span between two `---` lines is not YAML: every line must be
 * YAML-shaped AND at least one must be a real `key: value` (an empty block also counts). Without
 * the second condition a lone heading or a bulleted list between two leading rules would be
 * deleted, and a document that opens with a horizontal rule must not lose what follows it.
 */
export function stripFrontmatter(content: string): string {
  const match = FRONTMATTER_BLOCK.exec(content);
  if (!match) return content;
  const lines = (match[1] ?? '').split(/\r?\n/);
  const isYaml =
    lines.every(line => YAML_LINE.test(line)) &&
    (lines.some(line => KEY_VALUE_LINE.test(line)) || lines.every(line => line.trim() === ''));
  return isYaml ? content.slice(match[0].length) : content;
}
