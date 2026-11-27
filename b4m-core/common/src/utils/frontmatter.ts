/**
 * YAML front matter for markdown files: CLI skills, commands and agents, and the help articles.
 * Splits the file the way gray-matter did, which those files were written against, and parses
 * with the eemeli `yaml` package, which has no eval-capable engines. Sits behind
 * `@bike4mind/common/utils/frontmatter` so the barrel does not pull in a YAML parser.
 */
import YAML, { type ScalarTag } from 'yaml';

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

// Preserve the safe scalar schema used by existing skill, command and agent files.
const INTEGER_PATTERN =
  /^[-+]?(?:0|0b[01_]*[01]|0x[\da-fA-F_]*[\da-fA-F]|0[0-7_]*[0-7]|[1-9](?:[\d_]*\d)?|[1-9][\d_]*(?::[0-5]?\d)+)$/;
const FLOAT_PATTERN =
  /^(?!.*_$)(?:[-+]?(?:0|[1-9][\d_]*)(?:\.[\d_]*)?(?:[eE][-+]?\d+)?|\.[\d_]+(?:[eE][-+]?\d+)?|[-+]?\d[\d_]*(?::[0-5]?\d)+\.[\d_]*|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/;

function parseSafeNumber(source: string, integer: boolean): number {
  const normalized = source.replaceAll('_', '').toLowerCase();
  const sign = normalized.startsWith('-') ? -1 : 1;
  const value = normalized.replace(/^[-+]/, '');
  if (integer && value === '0') return 0;
  if (value === '.inf') return sign * Infinity;
  if (value === '.nan') return NaN;
  if (value.includes(':')) {
    const parts = value.split(':');
    return sign * parts.reduceRight((total, part, index) => total + Number(part) * 60 ** (parts.length - index - 1), 0);
  }
  if (!integer) return sign * Number.parseFloat(value);
  if (value.startsWith('0b')) return sign * Number.parseInt(value.slice(2), 2);
  if (value.startsWith('0x')) return sign * Number.parseInt(value.slice(2), 16);
  return sign * Number.parseInt(value, value.startsWith('0') ? 8 : 10);
}

const safeIntegerTag: ScalarTag = {
  tag: 'tag:yaml.org,2002:int',
  default: true,
  test: INTEGER_PATTERN,
  resolve: source => parseSafeNumber(source, true),
};
const safeFloatTag: ScalarTag = {
  tag: 'tag:yaml.org,2002:float',
  default: true,
  test: FLOAT_PATTERN,
  resolve: source => parseSafeNumber(source, false),
};

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

  // Keep strict booleans, legacy numeric forms, timestamps and merge keys without engines.
  const document = YAML.parseDocument(block, {
    schema: 'core',
    customTags: tags => [
      ...tags.filter(
        tag => typeof tag === 'string' || !['tag:yaml.org,2002:int', 'tag:yaml.org,2002:float'].includes(tag.tag)
      ),
      safeIntegerTag,
      safeFloatTag,
      'timestamp',
    ],
    merge: true,
    logLevel: 'error',
  });
  const parseError = document.errors[0] ?? document.warnings.find(warning => warning.code === 'TAG_RESOLVE_FAILED');
  if (parseError) throw parseError;
  const data: unknown = document.toJS();
  if (data === null) return { data: {}, content };
  if (Object.prototype.toString.call(data) !== '[object Object]') {
    throw new Error('The front matter must be a set of key: value pairs.');
  }
  return { data: data as Record<string, unknown>, content };
}
