import {
  FrontmatterLanguageError,
  parseFrontmatter as parseYamlFrontmatter,
  type ParsedFrontmatter,
} from '@bike4mind/common/utils/frontmatter';
import { logger } from './Logger.js';

/**
 * Frontmatter for SKILL.md, command and agent files, which are untrusted input. Only YAML is read:
 * a `---js`-style fence is never evaluated, and it, like malformed YAML, degrades to empty
 * frontmatter with a warning rather than throwing.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  try {
    return parseYamlFrontmatter(content);
  } catch (error) {
    if (error instanceof FrontmatterLanguageError) {
      logger.warn(`Ignoring non-YAML frontmatter language "${error.lang}"; treating frontmatter as empty`);
    } else {
      logger.warn(`Failed to parse frontmatter: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { data: {}, content: content.charCodeAt(0) === 0xfeff ? content.slice(1) : content };
  }
}
