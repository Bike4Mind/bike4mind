import { basename, dirname, sep } from 'node:path';
import type { PermissionList } from '@shared/permissions';
import { MCP_TOOL_PREFIX, serverSlug } from '../mcp/names';

type RuleKind = 'shell' | 'path' | 'domain' | 'plain';

interface ToolMapping {
  tools: readonly string[];
  kind: RuleKind;
}

/**
 * Claude Code's tool names and the desktop tools each one governs. The one place the mapping
 * lives: parsing, the card's derived rules and the Settings screen all read it.
 */
export const CLAUDE_CODE_TOOLS: Readonly<Record<string, ToolMapping>> = {
  Bash: { tools: ['bash_execute', 'bash_background'], kind: 'shell' },
  BashOutput: { tools: ['bash_output'], kind: 'plain' },
  KillShell: { tools: ['bash_kill'], kind: 'plain' },
  Read: { tools: ['file_read', 'glob_files', 'grep_search'], kind: 'path' },
  Glob: { tools: ['glob_files'], kind: 'plain' },
  Grep: { tools: ['grep_search'], kind: 'plain' },
  Edit: { tools: ['file_edit', 'file_write', 'apply_patch'], kind: 'path' },
  MultiEdit: { tools: ['file_edit', 'apply_patch'], kind: 'path' },
  Write: { tools: ['file_write'], kind: 'path' },
  WebFetch: { tools: ['web_fetch'], kind: 'domain' },
  WebSearch: { tools: ['web_search'], kind: 'plain' },
};

const DESKTOP_KIND = new Map<string, RuleKind>(
  Object.values(CLAUDE_CODE_TOOLS).flatMap(({ tools, kind }) => tools.map(tool => [tool, kind] as const))
);
// Glob and Grep are plain in Claude Code, but their desktop tools take Read's path rules.
for (const tool of CLAUDE_CODE_TOOLS.Read.tools) DESKTOP_KIND.set(tool, 'path');

const READ_TOOL = 'file_read';
const EDIT_TOOL = 'file_edit';

export type RuleMatcher =
  | { kind: 'any' }
  | { kind: 'shell'; exact: boolean; literal: string; pattern: RegExp }
  | { kind: 'path'; spec: string }
  | { kind: 'domain'; host: string; wildcard: boolean }
  | { kind: 'mcp'; server: string; tool: string | null };

export interface ParsedRule {
  text: string;
  /** The desktop tools the rule governs; empty for an MCP rule, which is matched by server instead. */
  tools: readonly string[];
  matcher: RuleMatcher;
}

export type ParseResult = { ok: true; rule: ParsedRule } | { ok: false; reason: string };

const SHAPE = /^([A-Za-z_][A-Za-z0-9_*-]*)(?:\((.*)\))?$/s;
/** A desktop tool's own name, which only the desktop's own rules may use. */
export const NATIVE_NAME = /^[a-z][a-z0-9_]*$/;

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function shellMatcher(spec: string): RuleMatcher | string {
  if (spec === '*') return { kind: 'any' };
  let body = spec;
  let prefix = false;
  if (body.endsWith(':*') || body.endsWith(' *')) {
    body = body.slice(0, -2);
    prefix = true;
  }
  if (body.trim() === '') return 'names no command';
  const star = body.indexOf('*');
  const source = body.split('*').map(escapeRegex).join('.*');
  // `ls *` must not cover `lsof`; a prefix ending in punctuation (`node -e '`) needs no boundary.
  const tail = prefix ? (/[A-Za-z0-9_]$/.test(body) ? '(?:\\s.*)?' : '.*') : '';
  return {
    kind: 'shell',
    exact: !prefix && star === -1,
    literal: star === -1 ? body : body.slice(0, star),
    pattern: new RegExp(`^${source}${tail}$`, 's'),
  };
}

function domainMatcher(spec: string): RuleMatcher | string {
  if (!spec.startsWith('domain:')) return 'WebFetch rules take domain:<host>, or no specifier for every site';
  const host = spec.slice('domain:'.length).trim().toLowerCase();
  if (!host || /[/\s]/.test(host)) return 'not a host name';
  return host.startsWith('*.')
    ? { kind: 'domain', host: host.slice(2), wildcard: true }
    : { kind: 'domain', host, wildcard: false };
}

/**
 * Parse one rule. `native` admits the desktop's own tool names (`session_spawn`) as well, which
 * only the desktop's own rules may use: in a Claude Code file such a name means nothing.
 */
export function parseRule(text: string, options: { native?: boolean } = {}): ParseResult {
  const trimmed = text.trim();
  const shape = SHAPE.exec(trimmed);
  if (!shape) return { ok: false, reason: 'not a rule: expected Tool or Tool(specifier)' };
  const [, name, spec] = shape;

  if (name.startsWith(MCP_TOOL_PREFIX)) {
    if (spec !== undefined) return { ok: false, reason: 'MCP rules take no specifier' };
    const rest = name.slice(MCP_TOOL_PREFIX.length);
    const split = rest.indexOf('__');
    const server = split === -1 ? rest : rest.slice(0, split);
    const tool = split === -1 ? null : rest.slice(split + 2);
    if (!server) return { ok: false, reason: 'names no MCP server' };
    return {
      ok: true,
      rule: {
        text: trimmed,
        tools: [],
        matcher: { kind: 'mcp', server: serverSlug(server), tool: tool && tool !== '*' ? cleanToolName(tool) : null },
      },
    };
  }

  const mapping = CLAUDE_CODE_TOOLS[name];
  if (!mapping) {
    if (options.native && NATIVE_NAME.test(name)) {
      const kind = DESKTOP_KIND.get(name);
      if (spec !== undefined && kind !== 'shell') return { ok: false, reason: `${name} takes no specifier here` };
      if (spec !== undefined) return withMatcher(trimmed, [name], shellMatcher(spec));
      return { ok: true, rule: { text: trimmed, tools: [name], matcher: { kind: 'any' } } };
    }
    return { ok: false, reason: `no desktop tool for ${name}` };
  }
  if (spec === undefined || spec === '*')
    return { ok: true, rule: { text: trimmed, tools: mapping.tools, matcher: { kind: 'any' } } };
  if (spec.trim() === '') return { ok: false, reason: 'empty specifier' };
  switch (mapping.kind) {
    case 'shell':
      return withMatcher(trimmed, mapping.tools, shellMatcher(spec));
    case 'domain':
      return withMatcher(trimmed, mapping.tools, domainMatcher(spec));
    case 'path':
      return { ok: true, rule: { text: trimmed, tools: mapping.tools, matcher: { kind: 'path', spec: spec.trim() } } };
    default:
      return { ok: false, reason: `${name} takes no specifier` };
  }
}

function withMatcher(text: string, tools: readonly string[], matcher: RuleMatcher | string): ParseResult {
  return typeof matcher === 'string' ? { ok: false, reason: matcher } : { ok: true, rule: { text, tools, matcher } };
}

/** The same cleaning McpManager gives a remote tool name, so a rule and a call compare alike. */
export function cleanToolName(name: string): string {
  return name
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** What a path rule is resolved against: `~/`, a leading `/` (the settings file's project or home), and a bare relative path. */
export interface PathBase {
  home: string;
  root: string | null;
  cwd: string | null;
}

function globToRegExp(glob: string): RegExp {
  const pattern = glob.endsWith('/') ? `${glob}**` : glob;
  let source = '';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index += 1;
      }
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += escapeRegex(char);
  }
  // gitignore: a pattern naming a directory covers everything inside it.
  return new RegExp(`^${source}(?:/.*)?$`, 's');
}

/**
 * A gitignore-style path rule as a matcher on absolute paths. `//x` is absolute, `~/x` is under
 * home, `/x` is under `base.root`, and anything else is under `base.cwd` - at any depth when it
 * names no directory, as in gitignore. Null when the rule needs a base this context lacks.
 */
export function compilePathGlob(spec: string, base: PathBase): RegExp | null {
  const expanded = absolutePathGlob(spec, base);
  return expanded === null ? null : globToRegExp(expanded);
}

function absolutePathGlob(spec: string, base: PathBase): string | null {
  const trim = (directory: string) => directory.replace(/\/+$/, '');
  if (spec.startsWith('//')) return spec.slice(1);
  if (spec === '~' || spec.startsWith('~/')) return trim(base.home) + spec.slice(1);
  if (spec.startsWith('/')) return base.root ? trim(base.root) + spec : null;
  if (!base.cwd) return null;
  const relative = spec.startsWith('./') ? spec.slice(2) : spec;
  const anyDepth = !relative.replace(/\/+$/, '').includes('/');
  return `${trim(base.cwd)}/${anyDepth ? '**/' : ''}${relative}`;
}

export interface RuleSource {
  id: string;
  label: string;
  path?: string;
}

type CompiledMatcher = Exclude<RuleMatcher, { kind: 'path' }> | { kind: 'path'; pattern: RegExp; searchRoot: string };

export interface CompiledRule {
  text: string;
  list: PermissionList;
  source: RuleSource;
  tools: readonly string[];
  matcher: CompiledMatcher;
}

/** Null when a path rule cannot be resolved in this context (a relative rule with no project). */
export function compileRule(
  parsed: ParsedRule,
  list: PermissionList,
  source: RuleSource,
  base: PathBase
): CompiledRule | null {
  const { matcher } = parsed;
  if (matcher.kind !== 'path') return { text: parsed.text, list, source, tools: parsed.tools, matcher };
  const absolute = absolutePathGlob(matcher.spec, base);
  if (absolute === null) return null;
  const wildcard = absolute.search(/[*?]/);
  // Before a wildcard the final component may itself be partial (`secr*`), so use its parent.
  const prefix = wildcard === -1 ? absolute : dirname(absolute.slice(0, wildcard) + 'x');
  const searchRoot = prefix.replace(/\/+$/, '') || '/';
  return {
    text: parsed.text,
    list,
    source,
    tools: parsed.tools,
    matcher: { kind: 'path', pattern: globToRegExp(absolute), searchRoot },
  };
}

export interface ShellSubjectCommand {
  text: string;
  words?: string;
  coverable: boolean;
  opaque?: string;
}

/** One tool call, reduced to what a rule can name. */
export interface PermissionSubject {
  tool: string;
  shell?: {
    script: string;
    commands: readonly ShellSubjectCommand[];
    directories: readonly string[];
    paths?: readonly string[];
  };
  paths?: readonly string[];
  /** A search may read descendants of any named path, rather than only the named file. */
  recursive?: boolean;
  host?: string;
  mcp?: { server: string; tool: string };
  irreversible?: boolean;
}

export type PermissionVerdict = { decision: PermissionList; rule: CompiledRule } | { decision: null };

const NO_VERDICT: PermissionVerdict = { decision: null };

/** Shell text that names a permission file, which an allow rule never waves through. */
const NAMES_RULE_FILE = /\.claude|permission-rules/;

function within(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

function isSettingsFile(path: string): boolean {
  const name = basename(path);
  return (name === 'settings.json' || name === 'settings.local.json') && basename(dirname(path)) === '.claude';
}

function hostMatches(host: string, rule: { host: string; wildcard: boolean }): boolean {
  const lower = host.toLowerCase();
  return rule.wildcard ? lower.endsWith(`.${rule.host}`) : lower === rule.host;
}

/**
 * Every rule that applies to one session, compiled once and indexed by tool, so a check per call
 * is a map lookup and a few regex tests.
 *
 * deny beats ask beats allow, whichever source each came from. Allow has floors no rule lifts:
 * an irreversible call; a shell sub-command the scan cannot read (`eval`, `bash -c "$X"`), unless
 * the rule names that form; one it could not normalise (an env assignment, a write redirect),
 * unless an exact rule names it; a folder outside the shared ones, unless a Read or Edit rule
 * covers it; and anything that reaches a permission file, which would let a call write its own
 * permissions.
 */
export class PermissionRuleSet {
  private readonly byTool = new Map<string, CompiledRule[]>();
  private readonly mcp: CompiledRule[] = [];
  private readonly folderAllows: CompiledRule[] = [];

  constructor(
    readonly rules: readonly CompiledRule[],
    private readonly protectedRoots: readonly string[] = []
  ) {
    for (const rule of rules) {
      if (rule.matcher.kind === 'mcp') this.mcp.push(rule);
      for (const tool of rule.tools) {
        const bucket = this.byTool.get(tool) ?? [];
        bucket.push(rule);
        this.byTool.set(tool, bucket);
      }
      if (
        rule.list === 'allow' &&
        (rule.tools.includes(READ_TOOL) || rule.tools.includes(EDIT_TOOL)) &&
        (rule.matcher.kind === 'path' || rule.matcher.kind === 'any')
      ) {
        this.folderAllows.push(rule);
      }
    }
  }

  get size(): number {
    return this.rules.length;
  }

  evaluate(subject: PermissionSubject): PermissionVerdict {
    const rules = subject.mcp ? this.mcp : (this.byTool.get(subject.tool) ?? []);
    if (rules.length === 0) return NO_VERDICT;
    for (const list of ['deny', 'ask'] as const) {
      const rule = rules.find(each => each.list === list && this.touches(each, subject));
      if (rule) return { decision: list, rule };
    }
    if (subject.irreversible) return NO_VERDICT;
    const rule = this.allowing(
      rules.filter(each => each.list === 'allow'),
      subject
    );
    return rule ? { decision: 'allow', rule } : NO_VERDICT;
  }

  /** Whether a folder outside the shared ones is covered by a Read or Edit allow rule. */
  coversFolder(directory: string): boolean {
    if (this.isProtectedFolder(directory)) return false;
    const probe = `${directory.replace(/\/+$/, '')}/x`;
    return this.folderAllows.some(
      rule =>
        rule.matcher.kind === 'any' ||
        (rule.matcher.kind === 'path' && (rule.matcher.pattern.test(directory) || rule.matcher.pattern.test(probe)))
    );
  }

  /** deny and ask: the rule names ANY part of the call. */
  private touches(rule: CompiledRule, subject: PermissionSubject): boolean {
    const { matcher } = rule;
    switch (matcher.kind) {
      case 'any':
        return true;
      case 'shell':
        return (subject.shell?.commands ?? []).some(
          command =>
            matcher.pattern.test(command.text) || (command.words !== undefined && matcher.pattern.test(command.words))
        );
      case 'path':
        // The probe makes `Read(~/.ssh/**)` refuse a search rooted at ~/.ssh itself.
        return (subject.paths ?? []).some(
          path =>
            matcher.pattern.test(path) ||
            matcher.pattern.test(`${path}/x`) ||
            (subject.recursive === true && (within(path, matcher.searchRoot) || within(matcher.searchRoot, path)))
        );
      case 'domain':
        return subject.host !== undefined && hostMatches(subject.host, matcher);
      case 'mcp':
        return this.mcpMatches(matcher, subject);
    }
  }

  /** allow: EVERY part of the call is covered, and no floor applies. The first covering rule, for the report. */
  private allowing(rules: readonly CompiledRule[], subject: PermissionSubject): CompiledRule | null {
    if (rules.length === 0) return null;
    if (subject.shell) {
      const { script, commands, directories } = subject.shell;
      if (commands.length === 0 || NAMES_RULE_FILE.test(script)) return null;
      if (this.protectedRoots.some(root => script.includes(root))) return null;
      if (subject.shell.paths?.some(path => this.isProtectedPath(path) || NAMES_RULE_FILE.test(path))) return null;
      if (!directories.every(directory => this.coversFolder(directory))) return null;
      let first: CompiledRule | null = null;
      for (const command of commands) {
        const rule = rules.find(each => this.coversCommand(each, command));
        if (!rule) return null;
        first ??= rule;
      }
      return first;
    }
    if (subject.paths) {
      const { paths } = subject;
      if (paths.length === 0 || paths.some(path => this.isProtectedPath(path))) return null;
      let first: CompiledRule | null = null;
      for (const path of paths) {
        const rule = rules.find(
          each => each.matcher.kind === 'any' || (each.matcher.kind === 'path' && each.matcher.pattern.test(path))
        );
        if (!rule) return null;
        first ??= rule;
      }
      return first;
    }
    return rules.find(rule => this.touches(rule, subject)) ?? null;
  }

  private coversCommand(rule: CompiledRule, command: ShellSubjectCommand): boolean {
    const { matcher } = rule;
    const words = command.words ?? command.text;
    // A bare Bash rule is the emptiest prefix, so it names no opaque form either.
    if (matcher.kind === 'any') return command.coverable && !command.opaque;
    if (matcher.kind !== 'shell') return false;
    if (!command.coverable) return matcher.exact && matcher.pattern.test(words);
    if (command.opaque) {
      return (matcher.exact || matcher.literal.trimEnd().startsWith(command.opaque)) && matcher.pattern.test(words);
    }
    return matcher.pattern.test(words) || matcher.pattern.test(command.text);
  }

  private mcpMatches(matcher: Extract<CompiledMatcher, { kind: 'mcp' }>, subject: PermissionSubject): boolean {
    if (!subject.mcp || subject.mcp.server !== matcher.server) return false;
    return matcher.tool === null || cleanToolName(subject.mcp.tool) === matcher.tool;
  }

  private isProtectedPath(path: string): boolean {
    return isSettingsFile(path) || this.protectedRoots.some(root => within(root, path));
  }

  /** Inside a protected folder, or above one: `cd ~ && cp x .claude/settings.json` reaches it from home. */
  private isProtectedFolder(directory: string): boolean {
    return this.protectedRoots.some(root => within(root, directory) || within(directory, root));
  }
}
