import { randomUUID } from 'node:crypto';
import { relative } from 'node:path';
import type { ChatUsage } from '@shared/chat';
import type { CompletionMessage } from '../completions';
import { createThinkFilter } from '../thinkFilter';
import { fileRead, globFiles, grepSearch } from './fileTools';
import { createLoopTally } from '../turnTiming';
import { capOutput, requireString, type ToolContext, type ToolDefinition } from './types';

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
      'and reads on its own (grep_search, glob_files, file_read only) and returns a concise report: ' +
      'file paths with line numbers, the relevant snippets and conventions, and what it could not ' +
      'find. Use it for exploration that would take many searches and reads, and call it several ' +
      'times in one reply with different questions to explore in parallel. When you already know ' +
      'the file or symbol, use grep_search or file_read directly instead.',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description:
            'What to find out, stated fully: the sub-agent sees nothing of this conversation. Say what ' +
            'you will do with the answer so it knows which details matter.',
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
    // Also on the round-limit exit, which is the slow one worth explaining.
    const finish = (report: string): string => {
      context.report?.detail(tally.summary());
      return report;
    };

    for (let round = 1; round <= MAX_EXPLORE_ROUNDS; round++) {
      const requested: NestedRequest[] = [];
      const filter = createThinkFilter();
      let text = '';
      let thinking: unknown[] | undefined;
      let usage: ChatUsage | undefined;

      await tally.model(() =>
        explore.complete(
          {
            model: explore.model,
            messages,
            tools,
            ...(explore.maxTokens ? { maxTokens: explore.maxTokens } : {}),
          },
          event => {
            if (event.type === 'error' || event.type === 'meta') return;
            if (event.text) text += filter.push(event.text).text;
            if (event.type === 'tool_use') {
              if (event.tools) requested.push(...event.tools);
              if (event.thinking) thinking = event.thinking;
            }
            if (event.usage) usage = event.usage;
          },
          context.signal
        )
      );
      text += filter.flush().text;
      // Within one request the counts are cumulative, so only the last report is billed.
      if (usage) explore.addUsage(usage);
      if (context.signal.aborted) throw new Error('Exploring was stopped.');

      if (requested.length === 0) return finish(capOutput(text.trim() || 'The explorer finished without a report.'));
      if (round === MAX_EXPLORE_ROUNDS) {
        const partial = text.trim();
        return finish(
          capOutput(
            `${partial ? `${partial}\n\n` : ''}[The explorer reached its ${MAX_EXPLORE_ROUNDS}-round limit before ` +
              'writing a full report.]'
          )
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
    return { ...base, content: capOutput(await tool.run(input, context)), error: false };
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
    'Stop as soon as you can answer. Finish with a concise report for the agent: the relevant file',
    'paths with line numbers, the key snippets and conventions it needs to follow, and what you',
    'looked for and could not find. Report only what the tools showed you - no speculation, and',
    'never invent a path, symbol or line.',
  ].join('\n');
}
