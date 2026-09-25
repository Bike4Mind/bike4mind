import matter from 'gray-matter';
import { logger } from './Logger.js';

/**
 * gray-matter selects its parse engine from the language tag on the opening
 * fence (e.g. `---js`), and its built-in `javascript` engine `eval()`s the
 * block - so a hostile SKILL.md/command/agent file can run code the moment it
 * is loaded, before any Zod validation. This helper is the single guard both
 * frontmatter call sites route through:
 *
 *  1. Reject any opening fence whose language tag is non-empty and not YAML.
 *  2. Disable the eval-capable engines as defense in depth (gray-matter merges
 *     a custom `engines` map ON TOP of its built-ins, so the override, not the
 *     absence, is what neutralizes `javascript`).
 *
 * A rejected or malformed file degrades to empty frontmatter (with a warning),
 * never an eval and never an uncaught throw.
 */

/** Opening `---<lang>` fence: capture the language tag on the first line. */
const OPENING_FENCE = /^---([^\r\n]*)\r?\n/;

function nonYamlEngineDisabled(): never {
  throw new Error('non-YAML frontmatter engine is disabled');
}

export function parseFrontmatter(content: string): { data: Record<string, unknown>; content: string } {
  // Strip a leading BOM: gray-matter strips it internally before selecting the
  // engine, so a BOM-prefixed "---js" file would slip past the fence check below and eval.
  if (content.charCodeAt(0) === 0xfeff) {
    content = content.slice(1);
  }

  const fence = content.match(OPENING_FENCE);
  if (fence) {
    const lang = fence[1].trim().toLowerCase();
    if (lang && lang !== 'yaml' && lang !== 'yml') {
      logger.warn(`Ignoring non-YAML frontmatter language "${lang}"; treating frontmatter as empty`);
      return { data: {}, content };
    }
  }

  try {
    const parsed = matter(content, {
      engines: { javascript: nonYamlEngineDisabled, coffee: nonYamlEngineDisabled },
    });
    return { data: parsed.data as Record<string, unknown>, content: parsed.content };
  } catch (error) {
    logger.warn(`Failed to parse frontmatter: ${error instanceof Error ? error.message : String(error)}`);
    return { data: {}, content };
  }
}
