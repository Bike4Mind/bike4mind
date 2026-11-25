/**
 * YAML front matter for markdown files: CLI skills, commands and agents, and the help articles.
 * Splits the file the way gray-matter did, which those files were written against, and parses
 * with the eemeli `yaml` package, which has no eval-capable engines. Sits behind
 * `@bike4mind/common/utils/frontmatter` so the barrel does not pull in a YAML parser.
 */
import YAML from 'yaml';

export interface ParsedFrontmatter {
  data: Record<string, unknown>;
  /** The file after the closing `---` line, or the whole file when it has no front matter. */
  content: string;
}

export class FrontmatterLanguageError extends Error {
  readonly lang: string;

  constructor(lang: string) {
    super(`Unsupported front matter language "${lang}"; only YAML is supported.`);
    this.name = 'FrontmatterLanguageError';
    this.lang = lang;
  }
}

const OPEN = '---';
const CLOSE = '\n---';

/**
 * Splits a leading `---` fence off `text` and parses it as YAML. A file that does not open with
 * `---` has no front matter; a fence that is never closed makes the rest of the file front matter.
 * Throws FrontmatterLanguageError for a language tag other than yaml/yml on the opening fence, and
 * an Error for invalid YAML or front matter that is not a set of key: value pairs.
 */
export function parseFrontmatter(text: string): ParsedFrontmatter {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!text.startsWith(OPEN) || text.charAt(OPEN.length) === '-') return { data: {}, content: text };

  let rest = text.slice(OPEN.length);
  const eol = rest.search(/\r?\n/);
  const lang = (eol === -1 ? rest : rest.slice(0, eol)).trim().toLowerCase();
  if (lang && lang !== 'yaml' && lang !== 'yml') throw new FrontmatterLanguageError(lang);
  rest = eol === -1 ? '' : rest.slice(eol);

  const close = rest.indexOf(CLOSE);
  // The CR of a CRLF before the closing fence; `yaml` would keep it in the last value.
  const block = close === -1 ? rest : rest.slice(0, close).replace(/\r$/, '');
  let content = close === -1 ? '' : rest.slice(close + CLOSE.length);
  if (content.startsWith('\r')) content = content.slice(1);
  if (content.startsWith('\n')) content = content.slice(1);

  if (block.replace(/^\s*#[^\n]+/gm, '').trim() === '') return { data: {}, content };

  // Matches js-yaml's safe schema, which gray-matter used: YAML 1.2 booleans (`yes` stays a
  // string), plus YAML 1.1 timestamps as Dates and `<<` merge keys.
  const data: unknown = YAML.parse(block, {
    schema: 'core',
    customTags: ['timestamp'],
    merge: true,
    logLevel: 'error',
  });
  if (data === null) return { data: {}, content };
  if (Object.prototype.toString.call(data) !== '[object Object]') {
    throw new Error('The front matter must be a set of key: value pairs.');
  }
  return { data: data as Record<string, unknown>, content };
}
