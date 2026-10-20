import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ApprovalPrompt } from '../tools/types';
import { CLAUDE_CODE_TOOLS, type CompiledRule, type PermissionSubject, cleanToolName } from './rules';

const SHELL_TOOLS = new Set(CLAUDE_CODE_TOOLS.Bash.tools);
const READ_TOOLS = new Set(CLAUDE_CODE_TOOLS.Read.tools);
const EDIT_TOOLS = new Set(CLAUDE_CODE_TOOLS.Edit.tools);
const FETCH_TOOLS = new Set(CLAUDE_CODE_TOOLS.WebFetch.tools);

interface CallLike {
  name: string;
  input: Record<string, unknown>;
}

interface PlaceLike {
  roots: readonly string[];
  workingDirectory?: string;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function absolute(path: string, place: PlaceLike): string {
  const expanded = path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
  return resolve(place.workingDirectory ?? place.roots[0] ?? homedir(), expanded);
}

function hostOf(url: unknown): string | undefined {
  try {
    return typeof url === 'string' ? new URL(url).hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/** What a rule can name about one call. `prompt` is absent for a call the tool did not gate. */
export function permissionSubject(
  call: CallLike,
  prompt: ApprovalPrompt | undefined,
  place: PlaceLike
): PermissionSubject {
  const irreversible = prompt?.irreversible ? { irreversible: true } : {};
  if (prompt?.mcp) return { tool: call.name, mcp: prompt.mcp, ...irreversible };
  if (SHELL_TOOLS.has(call.name)) {
    const script = text(call.input.command) ?? '';
    // A script the scan could not parse is one opaque command: only a rule naming all of it applies.
    const commands = prompt?.always?.commands ?? [{ text: script, words: script, coverable: false }];
    return {
      tool: call.name,
      shell: { script, commands, directories: prompt?.always?.directories ?? [] },
      ...irreversible,
    };
  }
  if (READ_TOOLS.has(call.name) || EDIT_TOOLS.has(call.name)) {
    const diffs = prompt?.diffs ?? (prompt?.diff ? [prompt.diff] : []);
    const requested = text(call.input.path);
    const paths =
      diffs.length > 0
        ? diffs.map(diff => diff.path)
        : requested
          ? [absolute(requested, place)]
          : READ_TOOLS.has(call.name)
            ? [absolute('.', place)]
            : [];
    return { tool: call.name, paths, ...irreversible };
  }
  if (FETCH_TOOLS.has(call.name)) {
    const host = hostOf(call.input.url);
    return { tool: call.name, ...(host ? { host } : {}), ...irreversible };
  }
  return { tool: call.name, ...irreversible };
}

/**
 * The rules "Always, in every session" would save for this call, in the same syntax as Claude
 * Code's settings; empty when the call has no rule as narrow as what the card shows.
 *
 * Never for an irreversible call or a card with a choice, and never for a shell command reaching
 * outside the shared folders or one the scan cannot read: a rule for those would either not cover
 * the next identical call or cover far more than the user was shown.
 */
export function everySessionRules(subject: PermissionSubject, prompt: ApprovalPrompt): string[] {
  if (prompt.irreversible || prompt.choice) return [];
  if (subject.mcp) return [`mcp__${subject.mcp.server}__${cleanToolName(subject.mcp.tool)}`];
  if (subject.shell) {
    const { commands, directories } = subject.shell;
    if (!prompt.always || directories.length > 0 || commands.length === 0) return [];
    if (commands.some(command => !command.coverable || command.opaque)) return [];
    const patterns = prompt.always.commands.map(({ pattern }) =>
      pattern.endsWith(' *') ? `Bash(${pattern.slice(0, -2)}:*)` : `Bash(${pattern})`
    );
    return [...new Set(patterns)];
  }
  if (subject.paths && subject.paths.length > 0) {
    if (subject.paths.some(path => /[*?[\]]/.test(path))) return [];
    const tool = EDIT_TOOLS.has(subject.tool) ? 'Edit' : 'Read';
    return [...new Set(subject.paths.map(path => `${tool}(/${path})`))];
  }
  if (subject.host) return [`WebFetch(domain:${subject.host})`];
  return [];
}

/** "Bash(rm:*) in Claude Code user (~/.claude/settings.json)", for a refusal or an ask. */
export function describeRule(rule: CompiledRule): string {
  const where = rule.source.path
    ? `${rule.source.label} (${rule.source.path.replace(homedir(), '~')})`
    : rule.source.label;
  return `${rule.text} in ${where}`;
}
