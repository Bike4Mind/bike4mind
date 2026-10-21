/**
 * The marker an exported SKILL.md carries so Bike4Mind can recognize its own exports. The B4M
 * CLI/desktop loader (packages/cli CustomCommandStore) skips stamped files, and a future CLI sync
 * keys off it to find files it owns - keep the `# Bike4Mind-Source: <url>` line format stable.
 *
 * Deliberately import-free so the stamp check never needs a YAML parser. skillMd.ts, which does need
 * one, sits behind `@bike4mind/common/utils/skillMd` rather than the barrel the CLI imports.
 */
export const SKILL_MD_SOURCE_MARKER = 'Bike4Mind-Source:';

/** Opening `---<lang>` fence, the frontmatter text, then the closing `---` line. */
const FRONTMATTER = /^---([^\r\n]*)\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

const SOURCE_LINE = new RegExp(`^[ \\t]*#[ \\t]*${SKILL_MD_SOURCE_MARKER}[ \\t]*(\\S+)`);

export interface SkillMdFrontmatterSplit {
  /** Lowercased language tag on the opening fence ('' for a plain `---`). */
  lang: string;
  /** Raw text between the fences, YAML comments included. */
  frontmatter: string;
  /** Everything after the closing fence. */
  rest: string;
}

/** Splits a SKILL.md into its raw frontmatter and the rest; null when there is no closed fence. */
export function splitSkillMdFrontmatter(text: string): SkillMdFrontmatterSplit | null {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const match = text.match(FRONTMATTER);
  if (!match) return null;
  return { lang: match[1].trim().toLowerCase(), frontmatter: match[2] ?? '', rest: text.slice(match[0].length) };
}

/** The source URL in the leading comment header, before any YAML data or scalar content. */
export function readSkillMdSourceUrl(frontmatter: string): string | undefined {
  for (const line of frontmatter.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // A marker below YAML data may be literal text inside a block or quoted scalar. Exports put
    // their marker before any data, so only inspect the leading comment header without parsing YAML.
    if (!trimmed.startsWith('#')) return undefined;
    const match = line.match(SOURCE_LINE);
    if (match) return match[1];
  }
  return undefined;
}

/**
 * True when the file's frontmatter carries the source stamp. Reads the raw fence text because the
 * stamp is a YAML comment, which every YAML parser (gray-matter included) discards.
 */
export function frontmatterHasSourceStamp(text: string): boolean {
  const split = splitSkillMdFrontmatter(text);
  return !!split && readSkillMdSourceUrl(split.frontmatter) !== undefined;
}
