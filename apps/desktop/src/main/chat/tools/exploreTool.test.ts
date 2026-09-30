import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatUsage } from '@shared/chat';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompletionRequest } from '../completions';
import type { CompletionStreamEvent } from '../streamEvents';
import { describeNested, exploreSystemPrompt, exploreTool, MAX_EXPLORE_ROUNDS } from './exploreTool';
import { MAX_EXPLORE_REPORT_CHARS, MAX_TOOL_OUTPUT_CHARS, outputCapFor } from './types';
import type { ExploreContext, ToolContext } from './types';

type Reply = CompletionStreamEvent[] | ((signal: AbortSignal) => CompletionStreamEvent[]);

function toolUse(tools: { name: string; input: Record<string, unknown> }[], usage?: ChatUsage): CompletionStreamEvent {
  return {
    type: 'tool_use',
    tools: tools.map((tool, index) => ({ id: `t${index}`, name: tool.name, arguments: JSON.stringify(tool.input) })),
    ...(usage ? { usage } : {}),
  };
}

function fakeExplore(replies: Reply[]): {
  explore: ExploreContext;
  requests: CompletionRequest[];
  usage: ChatUsage[];
} {
  const requests: CompletionRequest[] = [];
  const usage: ChatUsage[] = [];
  const explore: ExploreContext = {
    model: 'cheap-model',
    complete: async (request, onEvent, signal) => {
      // Snapshot: the tool keeps appending to the same array after this returns.
      requests.push({ ...request, messages: [...request.messages] });
      const next = replies.shift() ?? [];
      for (const event of typeof next === 'function' ? next(signal) : next) onEvent(event);
    },
    addUsage: spent => usage.push(spent),
  };
  return { explore, requests, usage };
}

describe('explore', () => {
  let root: string;
  let context: ToolContext;
  let progress: string[];

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-explore-')));
    await writeFile(join(root, 'app.ts'), 'export const answer = 42;\n', 'utf8');
    progress = [];
    context = {
      roots: [root],
      workingDirectory: root,
      signal: new AbortController().signal,
      report: {
        progress: text => progress.push(text),
        media: vi.fn(),
        notice: vi.fn(),
        label: vi.fn(),
        diff: vi.fn(),
      },
    };
  });

  it('runs its own loop on read-only tools and returns only the report', async () => {
    const { explore, requests, usage } = fakeExplore([
      [
        toolUse(
          [
            { name: 'grep_search', input: { pattern: 'answer' } },
            { name: 'file_read', input: { path: join(root, 'app.ts') } },
            { name: 'bash_execute', input: { command: 'rm -rf /' } },
          ],
          { inputTokens: 100, outputTokens: 10 }
        ),
      ],
      [{ type: 'content', text: 'app.ts:1 exports answer.', usage: { inputTokens: 200, outputTokens: 20 } }],
    ]);

    const report = await exploreTool.run({ question: 'where is answer?' }, { ...context, explore });

    expect(report).toBe('app.ts:1 exports answer.');
    expect(requests).toHaveLength(2);
    expect(requests[0].model).toBe('cheap-model');
    expect(requests[0].thinking).toBeUndefined();
    expect(requests[0].tools?.map(tool => (tool.toolSchema as { name: string }).name).sort()).toEqual([
      'file_read',
      'glob_files',
      'grep_search',
    ]);

    const results = requests[1].messages.at(-1)?.content as { tool_use_id: string; content: string; is_error?: true }[];
    expect(results.find(result => result.tool_use_id === 't1')?.content).toContain('answer = 42');
    const refused = results.find(result => result.tool_use_id === 't2');
    expect(refused).toMatchObject({ is_error: true });
    expect(refused?.content).toContain('Unknown tool');

    expect(usage).toEqual([
      { inputTokens: 100, outputTokens: 10 },
      { inputTokens: 200, outputTokens: 20 },
    ]);
    expect(progress).toContain('Reading app.ts (call 2)');
  });

  it('asks for the report one round before the cap and stops at it', async () => {
    const searching = toolUse([{ name: 'glob_files', input: { pattern: '*' } }]);
    const { explore, requests } = fakeExplore(
      Array.from({ length: MAX_EXPLORE_ROUNDS + 5 }, () => [{ ...searching, text: 'still looking' }])
    );

    const report = await exploreTool.run({ question: 'everything?' }, { ...context, explore });

    expect(requests).toHaveLength(MAX_EXPLORE_ROUNDS);
    expect(report).toContain('still looking');
    expect(report).toContain(`${MAX_EXPLORE_ROUNDS}-round limit`);
    expect(JSON.stringify(requests.at(-1)?.messages.at(-1)?.content)).toContain('Write your report now');
    expect(JSON.stringify(requests.at(-2)?.messages.at(-1)?.content)).not.toContain('Write your report now');
  });

  it('stops when the turn is stopped', async () => {
    const controller = new AbortController();
    const { explore, requests } = fakeExplore([
      () => {
        controller.abort();
        return [toolUse([{ name: 'glob_files', input: {} }])];
      },
      [{ type: 'content', text: 'never reached' }],
    ]);

    await expect(
      exploreTool.run({ question: 'q' }, { ...context, signal: controller.signal, explore })
    ).rejects.toThrow(/stopped/);
    expect(requests).toHaveLength(1);
  });

  it('passes the starting paths and the parent scope to the sub-agent', async () => {
    const { explore, requests } = fakeExplore([[{ type: 'content', text: 'done' }]]);

    await exploreTool.run({ question: 'q', paths: [join(root, 'app.ts'), 7] }, { ...context, explore });

    expect(requests[0].messages[0].content).toContain(root);
    expect(requests[0].messages[1].content).toBe(`q\n\nStart from:\n  ${join(root, 'app.ts')}`);
  });

  it('requires an edit-points section of verbatim, fenced, line-ranged code', () => {
    const prompt = exploreSystemPrompt({ roots: [root], workingDirectory: root });

    expect(prompt).toContain('"Edit points"');
    expect(prompt).toContain('exact line range');
    expect(prompt).toContain('verbatim current code');
    expect(prompt).toContain('fenced');
    expect(prompt).toContain('NOT seen any file');
  });

  it('does not truncate a long report below the explore cap', async () => {
    const long = 'x'.repeat(MAX_TOOL_OUTPUT_CHARS + 20_000);
    const { explore } = fakeExplore([[{ type: 'content', text: long }]]);

    const report = await exploreTool.run({ question: 'q' }, { ...context, explore });

    expect(report).toBe(long);
    expect(outputCapFor('explore')).toBe(MAX_EXPLORE_REPORT_CHARS);
    expect(outputCapFor('file_read')).toBe(MAX_TOOL_OUTPUT_CHARS);
  });

  it('still caps a report past the explore cap', async () => {
    const { explore } = fakeExplore([[{ type: 'content', text: 'y'.repeat(MAX_EXPLORE_REPORT_CHARS + 10) }]]);

    const report = await exploreTool.run({ question: 'q' }, { ...context, explore });

    expect(report).toContain('[truncated: 10 more characters]');
  });

  it('refuses without a transport', async () => {
    await expect(exploreTool.run({ question: 'q' }, context)).rejects.toThrow(/not available/);
  });
});

describe('describeNested', () => {
  it('names each call relative to the project', () => {
    expect(describeNested('file_read', { path: '/p/src/a.ts', offset: 10, limit: 5 }, '/p')).toBe(
      'Reading src/a.ts:10-14'
    );
    expect(describeNested('grep_search', { pattern: 'foo' }, '/p')).toBe('Searching for foo');
    expect(describeNested('glob_files', { pattern: '**/*.ts', path: '/p/src' }, '/p')).toBe('Listing **/*.ts in src');
  });
});
