/**
 * Conversion between Bike4Mind skills and Claude Code SKILL.md files (YAML frontmatter + markdown
 * body). Uses the eemeli `yaml` package: no eval-capable engines, so it is safe in the browser.
 */
import YAML from 'yaml';
import { SKILL_MD_SOURCE_MARKER, readSkillMdSourceUrl, splitSkillMdFrontmatter } from './skillMdSource';

export const SKILL_MD_THIRD_PARTY_NOTE = 'Third-party skill from the Bike4Mind Skill Market - review before use';

const THIRD_PARTY_LINE = new RegExp(`^\\s*#\\s*${SKILL_MD_THIRD_PARTY_NOTE}`, 'm');

/** Matches `@agent_name` mentions but not emails (`a@b.com`): `@` must follow whitespace or line start. */
const AGENT_MENTION = /(^|\s)@([a-z][a-z0-9_]+)/gm;

const SKILL_NAME_PATH_SAFE = /^[a-z0-9-]+$/;

export interface SkillMdFields {
  name?: string;
  description?: string;
  argumentHint?: string;
  body?: string;
  disableModelInvocation?: boolean;
}

export interface SkillMdSkill {
  name: string;
  description: string;
  body: string;
  argumentHint?: string;
  disableModelInvocation?: boolean;
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
  | { ok: false; error: string };

/** Serializes a skill to SKILL.md. allowedTools is never written: B4M tool names are not Claude Code tools. */
export function toSkillMd(skill: SkillMdSkill, opts: ToSkillMdOptions = {}): string {
  const comments: string[] = [];
  if (opts.sourceUrl) comments.push(`# ${SKILL_MD_SOURCE_MARKER} ${opts.sourceUrl.replace(/\s/g, '')}`);
  if (opts.version !== undefined) comments.push(`# Version: ${opts.version}`);
  if (opts.exportedAt) comments.push(`# Exported: ${opts.exportedAt.toISOString().slice(0, 10)}`);
  if (opts.thirdParty) comments.push(`# ${SKILL_MD_THIRD_PARTY_NOTE}`);

  const data: Record<string, unknown> = { name: skill.name, description: skill.description };
  if (skill.argumentHint) data['argument-hint'] = skill.argumentHint;
  if (skill.disableModelInvocation) data['disable-model-invocation'] = true;

  // lineWidth 0 disables folding so a long description stays on one line. The body always gets one
  // trailing newline, which parseSkillMd strips, so the round trip is lossless.
  const yaml = YAML.stringify(data, { lineWidth: 0 }).trimEnd();
  return ['---', ...comments, yaml, '---', '', `${skill.body}\n`].join('\n');
}

const toText = (value: unknown): string | undefined =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined;

/** Parses a SKILL.md into skill form fields. Never throws; a malformed file yields `ok: false`. */
export function parseSkillMd(text: string): ParseSkillMdResult {
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
    data = YAML.parse(split.frontmatter) ?? {};
  } catch (error) {
    return { ok: false, error: `Invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}` };
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
      case 'disable-model-invocation':
        fields.disableModelInvocation = value === true || value === 'true';
        break;
      // Everything else is reported as dropped, allowed-tools included: Claude Code tool names
      // (Bash/Read/Edit) are not B4M tools. Keep this rule in step with the other SKILL.md
      // importers (CLI push, desktop upload).
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

/** What in a skill only works inside Bike4Mind: its B4M tools and any `@agent` mentions in the body. */
export function b4mOnlyHints(skill: { body: string; allowedTools?: string[] }): { tools: string[]; agents: string[] } {
  const agents = new Set<string>();
  for (const match of skill.body.matchAll(AGENT_MENTION)) agents.add(match[2]);
  return { tools: skill.allowedTools ?? [], agents: [...agents] };
}

/**
 * One bash/zsh line that writes the skill to ~/.claude/skills/<name>/SKILL.md. The heredoc
 * delimiter is quoted (no expansion of `$` or backticks) and carries a random nonce that is
 * regenerated if the content happens to contain it.
 */
export function buildClaudeCodeInstallCommand(name: string, content: string): string {
  if (!SKILL_NAME_PATH_SAFE.test(name)) throw new Error(`Skill name "${name}" is not path-safe`);
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
