/**
 * The marker an exported SKILL.md carries so Bike4Mind can recognize its own exports. The B4M
 * CLI/desktop loader (packages/cli CustomCommandStore) skips stamped files, and a future CLI sync
 * keys off it to find files it owns - keep the `# Bike4Mind-Source: <url>` line format stable.
 *
 * Deliberately import-free: the CLI bundle imports this, and pulling in skillMd.ts would drag the
 * `yaml` package along with it.
 */
export const SKILL_MD_SOURCE_MARKER = 'Bike4Mind-Source:';

/** Opening `---<lang>` fence, the frontmatter text, then the closing `---` line. */
const FRONTMATTER = /^---([^\r\n]*)\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

const SOURCE_LINE = new RegExp(`^\\s*#\\s*${SKILL_MD_SOURCE_MARKER}[ \\t]*(\\S*)`, 'm');

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

/** The `# Bike4Mind-Source:` URL inside the raw frontmatter text, or undefined when unstamped. */
export function readSkillMdSourceUrl(frontmatter: string): string | undefined {
  return frontmatter.match(SOURCE_LINE)?.[1];
}

/**
 * True when the file's frontmatter carries the source stamp. Reads the raw fence text because the
 * stamp is a YAML comment, which every YAML parser (gray-matter included) discards.
 */
export function frontmatterHasSourceStamp(text: string): boolean {
  const split = splitSkillMdFrontmatter(text);
  return !!split && readSkillMdSourceUrl(split.frontmatter) !== undefined;
}
