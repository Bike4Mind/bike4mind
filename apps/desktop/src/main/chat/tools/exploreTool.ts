import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ChatUsage } from '@shared/chat';
import { withCacheBreakpoints, type CompletionMessage } from '../completions';
import { addUsage, foldUsage } from '../streamEvents';
import { createThinkFilter } from '../thinkFilter';
import { fileRead, globFiles, grepSearch } from './fileTools';
import { foldLine } from './patch';
import { createLoopTally } from '../turnTiming';
import {
  capOutput,
  outputCapFor,
  MAX_EXPLORE_REPORT_CHARS,
  requireString,
  type ExploreTarget,
  type ToolContext,
  type ToolDefinition,
} from './types';

/**
 * Requests one exploration may make, the last of which is told to stop and report. Enough for a
 * few batched search-then-read passes; an explorer still going past this is lost, and what it
 * has found so far is worth more to the parent than another minute of searching.
 */
export const MAX_EXPLORE_ROUNDS = 16;

/** Read-only by construction: nothing here runs a command, writes, or asks the user anything. */
const EXPLORE_TOOLS: readonly ToolDefinition[] = [fileRead, grepSearch, globFiles];
const EXPLORE_BY_NAME = new Map(EXPLORE_TOOLS.map(tool => [tool.schema.name, tool]));

const MAX_START_PATHS = 20;

interface NestedRequest {
  id?: string;
  name: string;
  arguments?: string;
}

interface NestedResult {
  id: string;
  name: string;
  input: Record<string, unknown>;
  content: string;
  error: boolean;
}

export const exploreTool: ToolDefinition = {
  schema: {
    name: 'explore',
    description:
      'Hand an open-ended question about the codebase to a faster read-only sub-agent. It searches ' +
      'and reads on its own (grep_search, glob_files, file_read only) and returns a report: file ' +
      'paths with line numbers, the relevant conventions, what it could not find, and an "Edit ' +
      'points" section quoting verbatim the code you will need to change or copy a pattern from, ' +
      'so you can edit against it without reading those files again. Its quotes are checked ' +
      'against the files, and any line flagged as not verbatim must be read again before you ' +
      'patch it. Use it for exploration that would take many searches and reads, and call it several ' +
      'times in one reply with different questions to explore in parallel. When you already know ' +
      'the file or symbol, use grep_search or file_read directly instead. Once you have delegated a ' +
      'search, do not redo it yourself; use the report.',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description:
            'What to find out, stated fully: the sub-agent sees nothing of this conversation. Say what ' +
            'you intend to build or change, so it can pick the edit points to quote (the code to ' +
            'edit, and the tests or fixtures to mirror) and you need not read them again.',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional absolute files or folders to start from.',
        },
      },
      required: ['question'],
    },
  },
  async run(input, context) {
    const explore = context.explore;
    if (!explore) throw new Error('Exploring is not available in this session.');
    const question = requireString(input, 'question');
    const paths = startPaths(input.paths);

    // Only the scope carries over. No reporter, background registry, media or host: the nested
    // calls must not be able to reach anything the three read tools do not.
    const readContext: ToolContext = {
      roots: context.roots,
      workingDirectory: context.workingDirectory,
      signal: context.signal,
      protectedPaths: context.protectedPaths,
    };
    const messages: CompletionMessage[] = [
      { role: 'system', content: exploreSystemPrompt(context) },
      { role: 'user', content: exploreBrief(question, paths) },
    ];
    const tools = EXPLORE_TOOLS.map(tool => ({ toolSchema: tool.schema }));
    let calls = 0;
    const tally = createLoopTally();
    let spent: ChatUsage | undefined;
    const readPaths = new Set<string>();
    // Also on the round-limit exit, which is the slow one worth explaining.
    const finish = async (report: string): Promise<string> => {
      context.report?.detail({ ...tally.summary(), ...(spent ? { usage: spent } : {}) });
      const note = await checkQuotes(report, readPaths, context.workingDirectory);
      // ChatService caps this result again at the same limit; leaving room keeps the note from being the part cut.
      return note
        ? `${capOutput(report, MAX_EXPLORE_REPORT_CHARS - note.length - CAP_MARKER_ROOM)}${note}`
        : capOutput(report, MAX_EXPLORE_REPORT_CHARS);
    };

    let target: ExploreTarget = explore;
    for (let round = 1; round <= MAX_EXPLORE_ROUNDS; round++) {
      const requested: NestedRequest[] = [];
      const filter = createThinkFilter();
      let text = '';
      let thinking: unknown[] | undefined;
      let usage: ChatUsage | undefined;

      const request = (on: ExploreTarget) =>
        explore.complete(
          {
            model: on.model,
            messages: on.cache ? withCacheBreakpoints(messages) : messages,
            tools,
            ...(on.maxTokens ? { maxTokens: on.maxTokens } : {}),
          },
          event => {
            if (event.type === 'error' || event.type === 'meta') return;
            if (event.text) text += filter.push(event.text).text;
            if (event.type === 'tool_use') {
              if (event.tools) requested.push(...event.tools);
              if (event.thinking) thinking = event.thinking;
            }
            usage = foldUsage(usage, event);
          },
          context.signal
        );

      await tally.model(async () => {
        try {
          await request(target);
        } catch (error) {
          // Round one only: later rounds carry this model's thinking blocks, which another
          // model would reject.
          const fallback = explore.fallback;
          if (round > 1 || !fallback || fallback.model === target.model || context.signal.aborted) throw error;
          target = fallback;
          text = '';
          requested.length = 0;
          thinking = undefined;
          usage = undefined;
          await request(target);
        }
      });
      text += filter.flush().text;
      // Within one request the counts are cumulative, so only the last report is billed.
      if (usage) {
        explore.addUsage(usage);
        spent = addUsage(spent, usage);
      }
      if (context.signal.aborted) throw new Error('Exploring was stopped.');

      if (requested.length === 0) return finish(text.trim() || 'The explorer finished without a report.');
      if (round === MAX_EXPLORE_ROUNDS) {
        const partial = text.trim();
        return finish(
          `${partial ? `${partial}\n\n` : ''}[The explorer reached its ${MAX_EXPLORE_ROUNDS}-round limit before ` +
            'writing a full report.]'
        );
      }

      const results = await tally.tools(() =>
        Promise.all(
          requested.map(request => {
            const index = ++calls;
            return runNested(request, readContext, line => context.report?.progress(`${line} (call ${index})`));
          })
        )
      );
      for (const result of results) {
        const path = result.input.path;
        if (result.name !== 'file_read' || result.error || typeof path !== 'string' || !path) continue;
        readPaths.add(isAbsolute(path) || !context.workingDirectory ? path : resolve(context.workingDirectory, path));
      }

      messages.push({
        role: 'assistant',
        content: [
          ...(thinking ?? []),
          ...(text ? [{ type: 'text', text }] : []),
          ...results.map(result => ({ type: 'tool_use', id: result.id, name: result.name, input: result.input })),
        ],
      });
      messages.push({
        role: 'user',
        content: [
          ...results.map(result => ({
            type: 'tool_result',
            tool_use_id: result.id,
            content: result.content,
            ...(result.error ? { is_error: true } : {}),
          })),
          // Warned one request early so the last one is spent writing the report, not searching.
          ...(round === MAX_EXPLORE_ROUNDS - 1
            ? [{ type: 'text', text: 'That was your last round of tools. Write your report now from what you have.' }]
            : []),
        ],
      });
    }
    // Unreachable: the last round returns above.
    throw new Error('The explorer ended without a report.');
  },
};

async function runNested(
  request: NestedRequest,
  context: ToolContext,
  progress: (line: string) => void
): Promise<NestedResult> {
  const input = parseArguments(request.arguments);
  const base = { id: request.id ?? randomUUID(), name: request.name, input };
  const tool = EXPLORE_BY_NAME.get(request.name);
  if (!tool) {
    return {
      ...base,
      content: `Unknown tool: ${request.name}. Only file_read, grep_search and glob_files are available.`,
      error: true,
    };
  }
  progress(describeNested(request.name, input, context.workingDirectory));
  try {
    return { ...base, content: capOutput(await tool.run(input, context), outputCapFor(request.name)), error: false };
  } catch (err) {
    return { ...base, content: err instanceof Error ? err.message : String(err), error: true };
  }
}

/** One progress line per nested call, in the words the transcript rows use. */
export function describeNested(name: string, input: Record<string, unknown>, workingDirectory?: string): string {
  const shown = (value: unknown): string => {
    if (typeof value !== 'string' || !value) return '';
    if (!workingDirectory || !value.startsWith(workingDirectory)) return value;
    return relative(workingDirectory, value) || '.';
  };
  if (name === 'file_read') {
    const offset = typeof input.offset === 'number' ? input.offset : undefined;
    const limit = typeof input.limit === 'number' ? input.limit : undefined;
    const range = offset ? `:${offset}${limit ? `-${offset + limit - 1}` : ''}` : '';
    return `Reading ${shown(input.path)}${range}`;
  }
  if (name === 'grep_search') return `Searching for ${String(input.pattern ?? '')}`;
  if (name === 'glob_files')
    return `Listing ${String(input.pattern ?? '*')}${input.path ? ` in ${shown(input.path)}` : ''}`;
  return `Running ${name}`;
}

function startPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    .slice(0, MAX_START_PATHS);
}

/** The "[truncated: N more characters]" line capOutput adds past its limit. */
const CAP_MARKER_ROOM = 64;
const MAX_CHECKED_FILE_BYTES = 1_000_000;
const MAX_FLAGGED_LINES = 8;
const MAX_FLAGGED_CHARS = 160;

/**
 * A note naming the lines in the report's code blocks that are not in the file cited before them.
 * The parent edits against these quotes without reading the files, so an explorer that abridged
 * one ("// returns 422 on validation failure...") would otherwise hand it a patch that cannot
 * match. Only files the explorer itself read are opened, so this reaches nothing it could not.
 */
export async function checkQuotes(
  report: string,
  readPaths: ReadonlySet<string>,
  workingDirectory?: string
): Promise<string> {
  if (readPaths.size === 0 || !report.includes('```')) return '';
  const shown = (path: string): string => {
    const rel = workingDirectory ? relative(workingDirectory, path) : '';
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path;
  };

  // Whole path names only: `index.ts` must not match inside `src/index.ts`, nor `a.ts` in `a.tsx`.
  const pathChar = /[\w./\\-]/;
  const bounded = (at: number, length: number): boolean =>
    !pathChar.test(report[at - 1] ?? ' ') &&
    !/[\w-]/.test(report[at + length] ?? ' ') &&
    !(report[at + length] === '.' && /\w/.test(report[at + length + 1] ?? ' '));
  const mentions: { at: number; path: string }[] = [];
  for (const path of readPaths) {
    for (const name of new Set([path, shown(path)])) {
      for (let at = report.indexOf(name); at !== -1; at = report.indexOf(name, at + 1)) {
        if (bounded(at, name.length)) mentions.push({ at, path });
      }
    }
  }
  mentions.sort((a, b) => a.at - b.at);

  const files = new Map<string, Set<string> | null>();
  const flagged: string[] = [];
  let next = 0;
  let cited: string | undefined;
  for (const block of report.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    while (next < mentions.length && mentions[next].at < (block.index ?? 0)) cited = mentions[next++].path;
    if (!cited) continue;
    let known = files.get(cited);
    if (known === undefined) {
      known = await foldedFileLines(cited);
      files.set(cited, known);
    }
    if (!known) continue;
    for (const raw of block[1].split('\n')) {
      // file_read's own line-number prefix, which the explorer is told to drop but sometimes keeps.
      const line = raw.replace(/^\s*\d+\t/, '');
      if (line.trim() === '' || known.has(foldLine(line))) continue;
      const text = line.trim();
      flagged.push(
        `  ${shown(cited)}: ${JSON.stringify(text.length > MAX_FLAGGED_CHARS ? `${text.slice(0, MAX_FLAGGED_CHARS)}...` : text)}`
      );
      if (flagged.length >= MAX_FLAGGED_LINES) break;
    }
    if (flagged.length >= MAX_FLAGGED_LINES) break;
  }
  if (flagged.length === 0) return '';
  return (
    '\n\n[Quote check: these lines in the code blocks above do not appear verbatim in the file cited ' +
    'before them, so they were abridged, paraphrased or are not quotes. Read those ranges with file_read ' +
    `before you patch them:\n${flagged.join('\n')}]`
  );
}

async function foldedFileLines(path: string): Promise<Set<string> | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_CHECKED_FILE_BYTES) return null;
    const text = await readFile(path, 'utf8');
    if (text.includes('\u0000')) return null;
    return new Set(text.split(/\r?\n/).map(foldLine));
  } catch {
    return null;
  }
}

function parseArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function exploreBrief(question: string, paths: readonly string[]): string {
  if (paths.length === 0) return question;
  return [question, '', 'Start from:', ...paths.map(path => `  ${path}`)].join('\n');
}

export function exploreSystemPrompt(context: Pick<ToolContext, 'roots' | 'workingDirectory'>): string {
  return [
    'You are a read-only code explorer working for another agent. Answer its question about the',
    'codebase and nothing else. You cannot change files or run commands; your tools are',
    'grep_search, glob_files and file_read.',
    ...(context.workingDirectory ? [`The project is at ${context.workingDirectory}.`] : []),
    'These folders are readable, including everything beneath them:',
    ...context.roots.map(root => `  ${root}`),
    'Always pass absolute paths.',
    'Tool calls made together in one reply run in parallel, so batch every independent search and',
    'read into one reply. Search before you read, then read only the range you need with offset',
    'and limit rather than whole files, and never re-read lines you already have.',
    'The agent you work for has NOT seen any file. Anything it would need to read again belongs in',
    'your report, so it can act on the report alone.',
    'Stop as soon as you can answer. Finish with a report: a short summary with file paths and line',
    'numbers, the conventions it needs to follow, and what you looked for and could not find.',
    'Report only what the tools showed you - no speculation, and never invent a path, symbol or line.',
    'End the report with a section headed "Edit points". List every place the agent will likely',
    'need to change or copy a pattern from, including existing tests and fixtures the new code',
    'should mirror. For each one give:',
    '  - the absolute path and exact line range',
    '  - the verbatim current code for that range, in a fenced block',
    '  - a one-line note on why it matters',
    'Copy each snippet character for character from file_read output, without the line-number',
    'prefixes, and never paraphrase or abridge it: the agent will match it exactly in an edit.',
    'Keep each excerpt tight, roughly under 60 lines, but complete enough to edit against. If the',
    'question does not say what will be built, infer the most likely change. The report may be',
    `long, but keep it under about ${Math.round(MAX_EXPLORE_REPORT_CHARS / 1000)}k characters and keep the summary short so the Edit points fit.`,
  ].join('\n');
}
