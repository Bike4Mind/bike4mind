import { ChatModels, DEFERRED_ANCHOR_TOOL_NAME } from '@bike4mind/common';
import type { ChatMessage, ChatToolCall } from '@shared/chat';
import { WEB_FETCH_TOOL_NAME, WEB_SEARCH_TOOL_NAME } from '@shared/webSearch';
import { describe, expect, it } from 'vitest';
import type { CompletionMessage } from './completions';
import {
  appendLiveToolChange,
  declareDeferredTools,
  estimateToolTokens,
  insertToolChanges,
  offersCoreTools,
  optionalToolNames,
  startToolNames,
  supportsDeferredTools,
  toolStateRecords,
  type WireTool,
} from './deferredTools';
import type { ToolSchema } from './tools/types';

const schema = (name: string): ToolSchema => ({
  name,
  description: name,
  parameters: { type: 'object', properties: {} },
});
const wire = (...names: string[]): WireTool[] => names.map(name => ({ toolSchema: schema(name) }));
const all = () => true;

let seq = 0;
const message = (role: ChatMessage['role'], extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `m${++seq}`,
  role,
  content: role,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...extra,
});
const call = (name: string) => ({ id: `c${++seq}`, name, arguments: '{}' }) as unknown as ChatToolCall;

describe('supportsDeferredTools', () => {
  it('is on for direct Anthropic Opus 5.5 only', () => {
    expect(supportsDeferredTools({ id: ChatModels.CLAUDE_5_5_OPUS, name: 'o', backend: 'anthropic' })).toBe(true);
    expect(supportsDeferredTools({ id: ChatModels.CLAUDE_5_5_OPUS, name: 'o', backend: 'bedrock' })).toBe(false);
    expect(supportsDeferredTools({ id: ChatModels.CLAUDE_5_SONNET, name: 's', backend: 'anthropic' })).toBe(false);
    expect(supportsDeferredTools(undefined)).toBe(false);
  });
});

describe('declareDeferredTools', () => {
  it('keeps the core tools loaded, defers the rest and the withdrawn, and adds the anchor', () => {
    const offered = wire(WEB_SEARCH_TOOL_NAME, WEB_FETCH_TOOL_NAME, 'file_read');
    expect(offersCoreTools(offered)).toBe(true);
    expect(offersCoreTools(wire(WEB_SEARCH_TOOL_NAME))).toBe(false);
    expect(optionalToolNames([...offered, ...wire('file_read')])).toEqual(['file_read']);

    const declared = declareDeferredTools(offered, [schema('file_read'), schema('bash')]);
    expect(declared.map(tool => [tool.toolSchema.name, !!tool.toolSchema.defer_loading])).toEqual([
      [WEB_SEARCH_TOOL_NAME, false],
      [WEB_FETCH_TOOL_NAME, false],
      ['file_read', true],
      ['bash', true],
      [DEFERRED_ANCHOR_TOOL_NAME, true],
    ]);
  });
});

describe('start set', () => {
  it('keeps the first record built-in tools loaded and diffs later records from them', () => {
    const first = { tools: [WEB_SEARCH_TOOL_NAME, 'ask_user', 'mcp_tool'], text: 't' };
    const start = startToolNames(first, name => name !== 'mcp_tool');
    expect(start).toEqual(['ask_user']);

    const declared = declareDeferredTools(
      wire(WEB_SEARCH_TOOL_NAME, WEB_FETCH_TOOL_NAME, 'mcp_tool'),
      [schema('ask_user')],
      new Set(start)
    );
    expect(declared.map(tool => [tool.toolSchema.name, !!tool.toolSchema.defer_loading])).toEqual([
      [WEB_SEARCH_TOOL_NAME, false],
      [WEB_FETCH_TOOL_NAME, false],
      ['mcp_tool', true],
      ['ask_user', false],
      [DEFERRED_ANCHOR_TOOL_NAME, true],
    ]);

    const { wire: out } = insertToolChanges(
      [{ role: 'user', content: 'x' }],
      [{ index: 0, tools: ['ask_user', 'mcp_tool'] }],
      all,
      start
    );
    expect(out[1]?.content).toEqual([{ type: 'tool_addition', tool: { type: 'tool_reference', name: 'mcp_tool' } }]);
    expect(estimateToolTokens([schema('ask_user')])).toBeGreaterThan(0);
  });
});

describe('toolStateRecords', () => {
  const state = (tools: string[], text = 't') => ({ tools, text });

  it('puts the first record on the first user turn with every tool the history already called', () => {
    const history = [
      message('user'),
      message('assistant', { toolCalls: [call('bash'), call(WEB_SEARCH_TOOL_NAME)] }),
      message('user'),
    ];
    const records = toolStateRecords(history, state(['file_read']), all);
    expect(records).toEqual([
      { messageId: history[0].id, state: state(['bash', 'file_read']) },
      { messageId: history[2].id, state: state(['file_read']) },
    ]);
  });

  it('adds nothing when the state has not moved, and a record on the new turn when it has', () => {
    const history = [message('user', { toolState: state(['a']) }), message('assistant'), message('user')];
    expect(toolStateRecords(history, state(['a']), all)).toEqual([]);
    expect(toolStateRecords(history, state(['a'], 'other'), all)).toEqual([
      { messageId: history[2].id, state: state(['a'], 'other') },
    ]);
  });
});

describe('insertToolChanges', () => {
  it('diffs each placed record against the one before, and moves a record past a user-user pair', () => {
    const messages: CompletionMessage[] = [
      { role: 'user', content: 'one' },
      { role: 'user', content: 'two' },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'three' },
    ];
    const { wire: out, referenced } = insertToolChanges(
      messages,
      [
        { index: 0, tools: ['a'] },
        { index: 3, tools: ['b'] },
      ],
      all
    );
    expect(out.map(entry => entry.role)).toEqual(['user', 'user', 'system', 'assistant', 'user', 'system']);
    expect(out[2].content).toEqual([{ type: 'tool_addition', tool: { type: 'tool_reference', name: 'a' } }]);
    expect(out[5].content).toEqual([
      { type: 'tool_removal', tool: { type: 'tool_reference', name: 'a' } },
      { type: 'tool_addition', tool: { type: 'tool_reference', name: 'b' } },
    ]);
    expect(referenced).toEqual(['a', 'b']);
  });

  it('drops names with no schema left', () => {
    const { wire: out } = insertToolChanges(
      [{ role: 'user', content: 'x' }],
      [{ index: 0, tools: ['gone'] }],
      name => name !== 'gone'
    );
    expect(out).toHaveLength(1);
  });
});

describe('appendLiveToolChange', () => {
  it('adds the reminder to the newest user turn and the change last', () => {
    const messages: CompletionMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [] },
      { role: 'user', content: [{ type: 'tool_result' }] },
    ];
    appendLiveToolChange(messages, ['a'], { tools: ['a', 'b'], text: 'now' });
    expect(messages[2].content).toEqual([
      { type: 'tool_result' },
      { type: 'text', text: '<system-reminder>\nnow\n</system-reminder>' },
    ]);
    expect(messages[3]).toEqual({
      role: 'system',
      content: [{ type: 'tool_addition', tool: { type: 'tool_reference', name: 'b' } }],
    });
  });
});
