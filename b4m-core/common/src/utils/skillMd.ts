/**
 * Conversion between Bike4Mind skills and Claude Code SKILL.md files (YAML frontmatter + markdown
 * body). Uses the eemeli `yaml` package: no eval-capable engines, so it is safe in the browser.
 */
import YAML from 'yaml';
import { SKILL_MD_SOURCE_MARKER, readSkillMdSourceUrl, splitSkillMdFrontmatter } from './skillMdSource';

export const SKILL_MD_THIRD_PARTY_NOTE = 'Third-party skill from the Bike4Mind Skill Market - review before use';

const THIRD_PARTY_LINE = new RegExp(`^\\s*#\\s*${SKILL_MD_THIRD_PARTY_NOTE}`, 'm');

/**
 * Matches `@agent_name` mentions but not emails (`a@b.com`): `@` must follow whitespace or line start.
 * A heuristic (it also hits `@param`), so the dialog words the warning as "may call".
 */
const AGENT_MENTION = /(^|\s)@([a-z][a-z0-9_]+)/gm;

const SKILL_NAME_PATH_SAFE = /^[a-z0-9-]+$/;

// Bytes a terminal may act on when the command is pasted: everything in C0 except LF (a tab triggers
// readline completion without bracketed paste), plus DEL and C1. A quoted heredoc does not protect against them.
// eslint-disable-next-line no-control-regex -- rejecting these bytes is the point of the check.
const UNSAFE_CONTROL_BYTES = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/;

export interface SkillMdFields {
  name?: string;
  description?: string;
  argumentHint?: string;
  body?: string;
  disableModelInvocation?: boolean;
  claudeCodeAllowedTools?: string[];
  claudeCodeModel?: string;
}

export interface SkillMdSkill {
  name: string;
  description: string;
  body: string;
  argumentHint?: string;
  disableModelInvocation?: boolean;
  claudeCodeAllowedTools?: string[];
  claudeCodeModel?: string;
}

export const CLAUDE_CODE_MODEL_MAX_LENGTH = 64;
const CLAUDE_CODE_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.:_-]*$/;

/** Trimmed `model` value when it is a plausible Claude Code alias or model id; no closed alias list. */
export function normalizeClaudeCodeModel(value: unknown): string | undefined {
  const model = typeof value === 'string' ? value.trim() : '';
  return model.length > 0 && model.length <= CLAUDE_CODE_MODEL_MAX_LENGTH && CLAUDE_CODE_MODEL_PATTERN.test(model)
    ? model
    : undefined;
}

export interface ToSkillMdOptions {
  /** Absolute URL of the B4M skill or listing page, written as the source stamp. */
  sourceUrl?: string;
  version?: number | string;
  /** Omit for byte-deterministic output (e.g. a hashed marketplace bundle). */
  exportedAt?: Date;
  thirdParty?: boolean;
}

export type ParseSkillMdResult =
  | {
      ok: true;
      fields: SkillMdFields;
      /** Top-level frontmatter keys Bike4Mind skills have no field for. */
      dropped: string[];
      /** Present when the file is a Bike4Mind export (carries the source stamp). */
      source?: { url: string; thirdParty: boolean };
    }
  | {
      ok: false;
      /** A plain-language message with the fix; the only field the CLI needs. */
      error: string;
      /** The raw parser message, when `error` is a friendlier rewording of it. */
      details?: string;
    };

/**
 * Serializes a skill to SKILL.md. allowedTools is never written (B4M tool names are not Claude Code
 * tools); claudeCodeAllowedTools and claudeCodeModel, the imported `allowed-tools` and `model`, are.
 */
export function toSkillMd(skill: SkillMdSkill, opts: ToSkillMdOptions = {}): string {
  const comments: string[] = [];
  if (opts.sourceUrl) comments.push(`# ${SKILL_MD_SOURCE_MARKER} ${opts.sourceUrl.replace(/\s/g, '')}`);
  if (opts.version !== undefined) comments.push(`# Version: ${opts.version}`);
  if (opts.exportedAt) comments.push(`# Exported: ${opts.exportedAt.toISOString().slice(0, 10)}`);
  if (opts.thirdParty) comments.push(`# ${SKILL_MD_THIRD_PARTY_NOTE}`);

  const data: Record<string, unknown> = { name: skill.name, description: skill.description };
  if (skill.argumentHint) data['argument-hint'] = skill.argumentHint;
  if (skill.disableModelInvocation) data['disable-model-invocation'] = true;
  if (skill.claudeCodeAllowedTools?.length) data['allowed-tools'] = skill.claudeCodeAllowedTools.join(', ');
  if (skill.claudeCodeModel) data.model = skill.claudeCodeModel;

  // lineWidth 0 disables folding so a long description stays on one line. The body always gets one
  // trailing newline, which parseSkillMd strips, so the round trip is lossless.
  const yaml = YAML.stringify(data, { lineWidth: 0 }).trimEnd();
  return ['---', ...comments, yaml, '---', '', `${skill.body}\n`].join('\n');
}

// Claude Code writes hints unquoted (`argument-hint: [pr-number] [priority]`), which YAML reads as a
// flow sequence or rejects outright (`<optional: title>`); quote the raw value so the hint survives
// verbatim. Already-quoted values and plain scalars are left alone.
const ARGUMENT_HINT_LINE = /^(argument-hint:[ \t]*)([^\r\n]+?)[ \t]*$/gm;

function quoteRawArgumentHint(frontmatter: string): string {
  return frontmatter.replace(ARGUMENT_HINT_LINE, (line, key: string, raw: string) => {
    if (/^["'|>]/.test(raw)) return line;
    // A trailing comment only follows a closed bracket or a plain scalar; inside `[pr #123]` the `#`
    // is part of the hint.
    const hint = (
      raw.startsWith('[') || raw.startsWith('<')
        ? raw.replace(/([\]>])[ \t]+#.*$/, '$1')
        : raw.replace(/[ \t]+#.*$/, '')
    ).trimEnd();
    return hint.startsWith('[') || hint.startsWith('<') || hint.includes(': ') ? `${key}${JSON.stringify(hint)}` : line;
  });
}

const toText = (value: unknown): string | undefined =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined;

/**
 * Claude Code's `allowed-tools`: a YAML list, or one string separated by commas or spaces. Every list
 * entry is split too, because the export joins them and Claude Code re-splits on commas and spaces. A space
 * inside parentheses (`Bash(git add:*)`) belongs to the entry; an unclosed `(` keeps the rest whole.
 */
export function splitAllowedTools(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(v => splitAllowedTools(toText(v)));
  const text = toText(value);
  if (!text) return [];
  const tools: string[] = [];
  let current = '';
  let depth = 0;
  for (const ch of text) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === ',' || /\s/.test(ch))) {
      if (current.trim()) tools.push(current.trim());
      current = '';
    } else current += ch;
  }
  if (current.trim()) tools.push(current.trim());
  return tools;
}

const UNQUOTED_TOP_LEVEL_VALUE = /^([^\s#:][^:]*?):[ \t]+(\S.*)$/;

/** Line of the first top-level `key: "value` whose opening quote never closes on its own line. */
function findUnclosedQuoteLine(lines: string[]): number | undefined {
  const index = lines.findIndex(line => {
    const match = line.match(/^[^\s#][^:]*:[ \t]+(["'])(.*)$/);
    if (!match) return false;
    const rest = match[2].replace(match[1] === '"' ? /\\./g : /''/g, '');
    return !rest.includes(match[1]);
  });
  return index === -1 ? undefined : index + 1;
}

/**
 * Turns a YAML failure into a message with a fix. The frontmatter starts on file line 2 (line 1 is
 * the opening ---), so every reported line is the frontmatter line plus one.
 */
function describeYamlError(frontmatter: string, error: unknown): ParseSkillMdResult {
  const details = error instanceof Error ? error.message : String(error);
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  const linePos =
    typeof error === 'object' && error !== null && 'linePos' in error
      ? (error.linePos as Array<{ line: number }> | undefined)
      : undefined;
  const lines = frontmatter.split('\n');
  const errorLine = linePos?.[0]?.line;
  const fail = (message: string): ParseSkillMdResult => ({ ok: false, error: message, details });

  if (code === 'TAB_AS_INDENT' && errorLine) {
    return fail(`Line ${errorLine + 1} uses a tab for indentation; YAML needs spaces.`);
  }
  if (code === 'MISSING_CHAR' && /quote/i.test(details)) {
    const line = findUnclosedQuoteLine(lines) ?? errorLine;
    if (line) return fail(`Line ${line + 1} has a quote that is never closed.`);
  }
  if (errorLine) {
    const match = lines[errorLine - 1]?.match(UNQUOTED_TOP_LEVEL_VALUE);
    if (match && !/^["'[{|>&*!]/.test(match[2]) && match[2].includes(': ')) {
      return fail(
        `Line ${errorLine + 1} (\`${match[1]}\`) has a colon followed by a space, which YAML reads as a new key. Wrap the value in double quotes.`
      );
    }
    return fail(`The frontmatter is not valid YAML (line ${errorLine + 1}).`);
  }
  return fail('The frontmatter is not valid YAML.');
}

/** Parses a SKILL.md into skill form fields. Never throws; a malformed file yields `ok: false`. */
export function parseSkillMd(input: string): ParseSkillMdResult {
  // Normalize line endings so a Windows-authored file does not leave `\r` in the body, where the
  // install command's control-byte guard would reject it.
  const text = input.replace(/\r\n?/g, '\n');
  const split = splitSkillMdFrontmatter(text);
  if (!split) {
    if (/^\uFEFF?---/.test(text)) return { ok: false, error: 'The frontmatter block has no closing --- line.' };
    return { ok: true, fields: { body: stripBodyNewlines(text.replace(/^\uFEFF/, '')) }, dropped: [] };
  }

  // Same rule as the CLI's parseFrontmatter: a non-YAML fence tag selects an eval-capable engine there.
  if (split.lang && split.lang !== 'yaml' && split.lang !== 'yml') {
    return { ok: false, error: `Unsupported frontmatter language "${split.lang}"; only YAML is supported.` };
  }

  let data: unknown;
  try {
    const frontmatter = quoteRawArgumentHint(split.frontmatter);
    data = YAML.parse(frontmatter) ?? {};
  } catch (error) {
    return describeYamlError(split.frontmatter, error);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, error: 'The frontmatter must be a set of key: value pairs.' };
  }

  const fields: SkillMdFields = { body: stripBodyNewlines(split.rest) };
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    switch (key) {
      case 'name':
        fields.name = toText(value);
        break;
      case 'description':
        fields.description = toText(value);
        break;
      case 'argument-hint':
        fields.argumentHint = toText(value);
        break;
      // Either key opts out, in any order, matching the CLI's parseCommandFile.
      case 'disable-model-invocation':
        fields.disableModelInvocation = fields.disableModelInvocation || value === true || value === 'true';
        break;
      case 'autoinvoke':
        fields.disableModelInvocation = fields.disableModelInvocation || value === false || value === 'false';
        break;
      // Kept in its own field, never in allowedTools: Claude Code tool names (Bash/Read/Edit) are not
      // B4M tools, and allowedTools narrows the skill's B4M tools at run time.
      case 'allowed-tools': {
        const tools = splitAllowedTools(value);
        if (tools.length) fields.claudeCodeAllowedTools = tools;
        else if (value != null && value !== '' && !(Array.isArray(value) && value.length === 0)) dropped.push(key);
        break;
      }
      case 'model': {
        const model = normalizeClaudeCodeModel(value);
        if (model) fields.claudeCodeModel = model;
        else if (value != null && value !== '') dropped.push(key);
        break;
      }
      default:
        dropped.push(key);
    }
  }

  const url = readSkillMdSourceUrl(split.frontmatter);
  return {
    ok: true,
    fields: Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as SkillMdFields,
    dropped,
    ...(url !== undefined && { source: { url, thirdParty: THIRD_PARTY_LINE.test(split.frontmatter) } }),
  };
}

/** Drops the blank line after the closing fence and the single trailing newline toSkillMd adds. */
function stripBodyNewlines(rest: string): string {
  return rest.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
}

// Markdown link/image targets, and bare file paths with a script/doc extension.
const MARKDOWN_LINK_TARGET = /!?\[[^\]\n]*\]\(\s*<?([^)\s>]+)/g;
const BARE_FILE_PATH =
  /(?<![\w/.:-])(?:\.{1,2}\/)?[\w-]+(?:[./][\w-]+)*\.(?:sh|py|js|ts|mjs|md|json|ya?ml|txt)\b(?![\w/-])/g;

// Repo-level docs live in the user's project, not the skill folder (README.md can ship in one).
const REPO_LEVEL_DOC = /^(?:\.\/)?(?:CLAUDE|AGENTS|CONTRIBUTING)\.md$/;
// Example paths in prose: `path/to/file.ts`, `src/foo.ts`, `src/foo*`.
const PLACEHOLDER_PATH = /(?:^|\/)path\/to\/|(?:^|\/)src\/(?:foo|bar|baz)(?:[.*]|$)|\*/i;

const isShippablePath = (path: string): boolean => !REPO_LEVEL_DOC.test(path) && !PLACEHOLDER_PATH.test(path);

/**
 * Relative paths a skill body references, e.g. `scripts/run.sh` or `[guide](reference.md)`: files a
 * Claude Code skill folder ships beside its SKILL.md, which an import of the SKILL.md alone loses.
 * ponytail: regex heuristic (misses extensionless paths, may hit a filename named in prose); a real
 * markdown parse if the warning proves noisy.
 */
export function referencedRelativePaths(body: string): string[] {
  const paths = new Set<string>();
  for (const match of body.matchAll(MARKDOWN_LINK_TARGET)) {
    const target = match[1].split('#')[0];
    if (target && !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('/') && isShippablePath(target)) {
      paths.add(target);
    }
  }
  // URLs are removed first so `https://x.test/a/install.sh` is not read as a relative path.
  for (const match of body.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ').matchAll(BARE_FILE_PATH)) {
    // Without a directory, only script/doc names: `package.json` or `Node.js` in prose is not a sibling file.
    if ((match[0].includes('/') || /\.(?:sh|py|md)$/.test(match[0])) && isShippablePath(match[0])) paths.add(match[0]);
  }
  return [...paths];
}

/** What in a skill only works inside Bike4Mind: its B4M tools and any `@agent` mentions in the body. */
export function b4mOnlyHints(skill: { body: string; allowedTools?: string[] }): { tools: string[]; agents: string[] } {
  const agents = new Set<string>();
  for (const match of skill.body.matchAll(AGENT_MENTION)) agents.add(match[2]);
  return { tools: skill.allowedTools ?? [], agents: [...agents] };
}

/**
 * One bash/zsh line that writes the skill to ~/.claude/skills/<name>/SKILL.md. The heredoc
 * delimiter is quoted (no expansion of `$` or backticks) and carries a random nonce that is
 * regenerated if the content happens to contain it. Content with terminal control bytes is
 * rejected: a pasted heredoc cannot protect against them, and the Download path can.
 */
export function buildClaudeCodeInstallCommand(name: string, content: string): string {
  if (!SKILL_NAME_PATH_SAFE.test(name)) throw new Error(`Skill name "${name}" is not path-safe`);
  if (UNSAFE_CONTROL_BYTES.test(content)) throw new Error('Skill content has terminal control characters');
  let delimiter: string;
  do {
    const nonce = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(6)), b =>
      b.toString(16).padStart(2, '0')
    ).join('');
    delimiter = `B4M_SKILL_${nonce}`;
  } while (content.includes(delimiter));
  const dir = `~/.claude/skills/${name}`;
  const body = content.endsWith('\n') ? content : `${content}\n`;
  return `mkdir -p ${dir} && cat > ${dir}/SKILL.md <<'${delimiter}'\n${body}${delimiter}`;
}
