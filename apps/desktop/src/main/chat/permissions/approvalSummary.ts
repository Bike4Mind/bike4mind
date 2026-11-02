import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import { arityPrefix } from '../tools/bashArity';
import type { ApprovalLogEntry } from './ApprovalLog';

/**
 * A digest of the approval log a user can hand to a maintainer: which calls asked, why, and how
 * they were answered. It names command patterns (`git commit *`) and project folder names only,
 * never a full command, a path or a URL, so it is safe to share where the raw log is not.
 */
export type ApprovalSummary = {
  from: string | null;
  to: string | null;
  total: number;
  asked: number;
  askedAllowed: number;
  askedDenied: number;
  /** Seconds between a card appearing and its answer, over the cards that recorded both. */
  waited: { total: number; median: number | null };
  deciders: Row<'decider'>[];
  reasons: Row<'reason'>[];
  /** Asked patterns, most asked first. */
  prompted: PatternRow[];
  /** Asked at least twice and never denied: the candidates to stop asking about. */
  alwaysAllowed: PatternRow[];
  /** Calls the app refused on its own (`decidedBy.kind === 'system'`, reason 'error'). */
  refusals: Row<'pattern'>[];
};

type Row<Key extends string> = { [K in Key]: string } & { count: number };

export type PatternRow = {
  tool: string;
  pattern: string;
  project: string | null;
  asked: number;
  allowed: number;
  denied: number;
};

const TOP_ROWS = 25;

/** Every entry in these log files, oldest file first; unreadable files and malformed lines are skipped. */
export async function readApprovalLog(paths: readonly string[]): Promise<ApprovalLogEntry[]> {
  const entries: ApprovalLogEntry[] = [];
  for (const path of paths) {
    const text = await readFile(path, 'utf8').catch(() => '');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry: unknown = JSON.parse(line);
        if (isEntry(entry)) entries.push(entry);
      } catch {
        // A line cut short by a crash mid-append; the rest of the log is still worth reading.
      }
    }
  }
  return entries;
}

function isEntry(value: unknown): value is ApprovalLogEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  const approval = entry.approval as Record<string, unknown> | undefined;
  return (
    typeof entry.ts === 'string' &&
    typeof entry.tool === 'string' &&
    typeof entry.input === 'string' &&
    typeof approval === 'object' &&
    approval !== null &&
    typeof approval.asked === 'boolean' &&
    typeof approval.decidedBy === 'object'
  );
}

/** Words that open or close a block rather than name a program; `do echo x` is an `echo`. */
const SHELL_KEYWORDS = new Set(['do', 'done', 'then', 'else', 'elif', 'fi', 'esac', 'in', '!']);
/** A word that can name a program; an assignment, a redirect or a stray quote cannot. */
const PROGRAM = /^[\w.~/][\w.~/+-]*$/;

/**
 * The patterns an entry stands for. Entries logged before patterns were recorded fall back to
 * the first words of each sub-command, which is close enough to group on. Non-shell tools are
 * grouped by tool alone: their input is a path or URL, which the summary must not carry.
 */
export function entryPatterns(entry: ApprovalLogEntry, home = homedir()): string[] {
  // A program named by absolute path (`/Users/jude/bin/x *`) would carry the user's home.
  const withoutHome = (pattern: string) => pattern.split(home).join('~');
  if (entry.patterns && entry.patterns.length > 0) return [...new Set(entry.patterns.map(withoutHome))];
  if (!entry.tool.startsWith('bash')) return [entry.tool];
  // Quoted text is blanked first, so a `node -e '...'` body or a quoted `|` does not split.
  const patterns = entry.input
    .replace(/'[^']*'?|"(?:[^"\\]|\\.)*"?/g, 'Q')
    .split(/&&|\|\||[;|&\n(){}]/)
    .map(part => part.trim().split(/\s+/).filter(Boolean))
    .map(tokens => (SHELL_KEYWORDS.has(tokens[0]) ? tokens.slice(1) : tokens))
    .filter(tokens => tokens.length > 0 && PROGRAM.test(tokens[0]))
    .map(tokens => withoutHome(`${arityPrefix(tokens).join(' ')} *`));
  return patterns.length > 0 ? [...new Set(patterns)] : [entry.tool];
}

function deciderLabel(entry: ApprovalLogEntry): string {
  const decidedBy = entry.approval.decidedBy;
  switch (decidedBy.kind) {
    case 'user':
      return `user: ${decidedBy.answer}${decidedBy.everywhere ? ' (everywhere)' : ''}`;
    case 'mode':
      return `mode: ${decidedBy.mode}`;
    case 'rule':
      return `rule${decidedBy.source ? ` (${decidedBy.source})` : ''}`;
    case 'chat-allowance':
      return 'allowed earlier in this chat';
    case 'system':
      return `system: ${decidedBy.reason}`;
  }
}

/** Why a card asked, without the free text: `untrusted content (web_fetch)`, `ask rule`, ... */
function reasonLabel(entry: ApprovalLogEntry): string {
  const because = entry.approval.askedBecause;
  if (!because) return "the tool's own check (outside folder, outbound, .env, ...) or ask mode";
  const reasons: string[] = [];
  const source = /read content from[^(]*\((\w+)\)/.exec(because);
  if (source) reasons.push(`untrusted content (${source[1]})`);
  if (/because of the rule/.test(because)) reasons.push('ask rule');
  if (/repeated \d+ times/.test(because)) reasons.push('repeated call');
  return reasons.length > 0 ? reasons.join(' + ') : 'other';
}

function counted<Key extends string>(key: Key, values: readonly string[]): Row<Key>[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value, count]) => ({ [key]: value, count }) as Row<Key>);
}

function secondsBetween(from: string | undefined, to: string): number | null {
  if (!from) return null;
  const seconds = (Date.parse(to) - Date.parse(from)) / 1000;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

export function summarizeApprovals(entries: readonly ApprovalLogEntry[]): ApprovalSummary {
  const asked = entries.filter(entry => entry.approval.asked);
  const waits = asked
    .map(entry => secondsBetween(entry.approval.requestedAt, entry.approval.decidedAt))
    .filter((seconds): seconds is number => seconds !== null)
    .sort((a, b) => a - b);

  const rows = new Map<string, PatternRow>();
  for (const entry of asked) {
    const project = entry.project ? basename(entry.project) : null;
    for (const pattern of entryPatterns(entry)) {
      const key = `${entry.tool}\x00${pattern}\x00${project ?? ''}`;
      const row = rows.get(key) ?? { tool: entry.tool, pattern, project, asked: 0, allowed: 0, denied: 0 };
      row.asked++;
      if (entry.approval.outcome === 'allowed') row.allowed++;
      else row.denied++;
      rows.set(key, row);
    }
  }
  const prompted = [...rows.values()].sort((a, b) => b.asked - a.asked || a.pattern.localeCompare(b.pattern));

  const refused = entries.filter(
    entry => entry.approval.decidedBy.kind === 'system' && entry.approval.decidedBy.reason === 'error'
  );

  return {
    from: entries[0]?.ts ?? null,
    to: entries.at(-1)?.ts ?? null,
    total: entries.length,
    asked: asked.length,
    askedAllowed: asked.filter(entry => entry.approval.outcome === 'allowed').length,
    askedDenied: asked.filter(entry => entry.approval.outcome === 'denied').length,
    waited: {
      total: Math.round(waits.reduce((sum, seconds) => sum + seconds, 0)),
      median: waits.length > 0 ? Math.round(waits[Math.floor(waits.length / 2)]) : null,
    },
    deciders: counted('decider', entries.map(deciderLabel)),
    reasons: counted('reason', asked.map(reasonLabel)),
    prompted: prompted.slice(0, TOP_ROWS),
    alwaysAllowed: prompted.filter(row => row.asked >= 2 && row.denied === 0).slice(0, TOP_ROWS),
    refusals: counted(
      'pattern',
      refused.flatMap(entry => entryPatterns(entry).map(pattern => `${entry.tool}: ${pattern}`))
    ),
  };
}

function table(header: readonly string[], rows: readonly (readonly (string | number)[])[]): string {
  if (rows.length === 0) return '_None._';
  const line = (cells: readonly (string | number)[]) =>
    `| ${cells.map(cell => String(cell).replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}

function patternTable(rows: readonly PatternRow[]): string {
  return table(
    ['Tool', 'Pattern', 'Project', 'Asked', 'Allowed', 'Denied'],
    rows.map(row => [row.tool, `\`${row.pattern}\``, row.project ?? '-', row.asked, row.allowed, row.denied])
  );
}

/** The summary as a Markdown report, ready to attach to an issue or send to a maintainer. */
export function formatApprovalSummary(summary: ApprovalSummary): string {
  const share = (part: number) => (summary.total > 0 ? ` (${Math.round((part / summary.total) * 100)}%)` : '');
  return [
    '# Bike4Mind Desktop approval summary',
    '',
    'Generated on this computer from the local approval log. It lists command patterns and project folder names only, never full commands, file paths, URLs or file contents.',
    '',
    `- Period: ${summary.from ?? '-'} to ${summary.to ?? '-'}`,
    `- Gated tool calls: ${summary.total}`,
    `- Asked: ${summary.asked}${share(summary.asked)}, of which allowed ${summary.askedAllowed} and denied ${summary.askedDenied}`,
    `- Time spent waiting on cards: ${summary.waited.total}s (median ${summary.waited.median ?? '-'}s)`,
    '',
    '## Who decided',
    '',
    table(
      ['Decided by', 'Calls'],
      summary.deciders.map(row => [row.decider, row.count])
    ),
    '',
    '## Why cards asked',
    '',
    table(
      ['Reason', 'Cards'],
      summary.reasons.map(row => [row.reason, row.count])
    ),
    '',
    '## Most asked',
    '',
    'A card for a compound command counts once for each of its sub-commands.',
    '',
    patternTable(summary.prompted),
    '',
    '## Asked repeatedly and always allowed',
    '',
    'Candidates for a permission rule, or for the app to stop asking.',
    '',
    patternTable(summary.alwaysAllowed),
    '',
    '## Refused by the app on its own',
    '',
    table(
      ['Call', 'Count'],
      summary.refusals.map(row => [row.pattern, row.count])
    ),
    '',
  ].join('\n');
}
