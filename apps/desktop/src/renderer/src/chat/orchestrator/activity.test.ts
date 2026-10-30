import type { ChatStreamEvent, ChatToolCall } from '@shared/chat';
import { describe, expect, it } from 'vitest';
import {
  activityLabel,
  describeToolInput,
  foldActivity,
  toolKind,
  type AgentActivity,
  type ToolKind,
} from './activity';

const call = (name: string, input: Record<string, unknown> = {}): ChatToolCall => ({
  id: 'call-1',
  name,
  input,
  status: 'running',
});

const base = { sessionId: 's1', messageId: 'm1' };

describe('foldActivity', () => {
  it('walks tool -> waiting -> absent over a tool round and the end of the turn', () => {
    const empty: ReadonlyMap<string, AgentActivity> = new Map();
    const started = foldActivity(empty, {
      type: 'tool-start',
      ...base,
      call: call('file_edit', { path: '/a/b/X.ts' }),
    });
    expect(started.get('s1')).toEqual({ kind: 'tool', tool: 'file_edit', detail: 'X.ts' });

    const ended = foldActivity(started, { type: 'tool-end', ...base, call: call('file_edit') });
    expect(ended.get('s1')).toEqual({ kind: 'phase', phase: 'waiting' });

    const done = foldActivity(ended, { type: 'done', ...base, content: '' });
    expect(done.has('s1')).toBe(false);
  });

  it('drops the entry on error', () => {
    const current = new Map<string, AgentActivity>([['s1', { kind: 'phase', phase: 'thinking' }]]);
    expect(foldActivity(current, { type: 'error', ...base, message: 'boom' }).has('s1')).toBe(false);
  });

  it('maps a phase event, carrying the tool name only for writing-tool', () => {
    const empty: ReadonlyMap<string, AgentActivity> = new Map();
    const thinking = foldActivity(empty, { type: 'phase', ...base, phase: { kind: 'thinking' } });
    expect(thinking.get('s1')).toEqual({ kind: 'phase', phase: 'thinking' });
    const writing = foldActivity(empty, {
      type: 'phase',
      ...base,
      phase: { kind: 'writing-tool', name: 'file_write' },
    });
    expect(writing.get('s1')).toEqual({ kind: 'phase', phase: 'writing-tool', tool: 'file_write' });
  });

  it('returns the identical map for an event it does not track', () => {
    const current = new Map<string, AgentActivity>([['s1', { kind: 'phase', phase: 'thinking' }]]);
    const event: ChatStreamEvent = { type: 'background-output', sessionId: 's1', processId: 'p', text: 'x' } as never;
    expect(foldActivity(current, event)).toBe(current);
  });

  it('returns the identical map for a repeated identical phase', () => {
    const event: ChatStreamEvent = { type: 'phase', ...base, phase: { kind: 'responding' } };
    const first = foldActivity(new Map(), event);
    expect(foldActivity(first, event)).toBe(first);
  });

  it('returns the identical map when done arrives for a session with no entry', () => {
    const current: ReadonlyMap<string, AgentActivity> = new Map();
    expect(foldActivity(current, { type: 'done', ...base, content: '' })).toBe(current);
  });

  it('does not mutate the map it was given', () => {
    const current: ReadonlyMap<string, AgentActivity> = new Map();
    foldActivity(current, { type: 'phase', ...base, phase: { kind: 'thinking' } });
    expect(current.size).toBe(0);
  });
});

describe('describeToolInput', () => {
  it('reduces a path to its basename', () => {
    expect(describeToolInput({ name: 'file_edit', input: { path: '/a/b/ChatService.ts' } })).toBe('ChatService.ts');
    expect(describeToolInput({ name: 'file_read', input: { file_path: 'C:\\x\\y\\Z.ts' } })).toBe('Z.ts');
  });

  it('prefers keys in order and skips non-strings', () => {
    expect(describeToolInput({ name: 'x', input: { path: 5, command: 'pnpm test', query: 'q' } })).toBe('pnpm test');
    expect(describeToolInput({ name: 'x', input: { pattern: '*.ts', query: 'q' } })).toBe('*.ts');
    expect(describeToolInput({ name: 'x', input: { url: 'https://example.com' } })).toBe('https://example.com');
  });

  it('is empty when nothing describes the call', () => {
    expect(describeToolInput({ name: 'x', input: {} })).toBe('');
  });

  it('collapses to one line and caps at 60 characters', () => {
    const detail = describeToolInput({ name: 'bash_execute', input: { command: `echo\n${'a'.repeat(100)}` } });
    expect(detail).not.toContain('\n');
    expect(detail.length).toBe(60);
    expect(detail.endsWith('...')).toBe(true);
  });
});

describe('toolKind', () => {
  // One row per tool registered in main/chat/tools/registry.ts, so a new name lands here on purpose.
  const table: ReadonlyArray<readonly [string, ToolKind]> = [
    ['apply_patch', 'edit'],
    ['file_write', 'edit'],
    ['file_edit', 'edit'],
    ['memory_write', 'edit'],
    ['todo_write', 'edit'],
    ['bash_execute', 'shell'],
    ['bash_background', 'shell'],
    ['bash_output', 'shell'],
    ['bash_list', 'shell'],
    ['bash_kill', 'shell'],
    ['web_search', 'web'],
    ['web_fetch', 'web'],
    ['browser_navigate', 'web'],
    ['browser_tabs', 'web'],
    ['browser_snapshot', 'web'],
    ['browser_click', 'web'],
    ['browser_type', 'web'],
    ['browser_press', 'web'],
    ['browser_scroll', 'web'],
    ['browser_back', 'web'],
    ['browser_screenshot', 'web'],
    ['browser_evaluate', 'web'],
    ['file_read', 'read'],
    ['glob_files', 'read'],
    ['grep_search', 'read'],
    ['memory_read', 'read'],
    ['mcp_list_servers', 'read'],
    ['session_list', 'agent'],
    ['session_read', 'agent'],
    ['session_spawn', 'agent'],
    ['session_send', 'agent'],
    ['session_archive', 'agent'],
    ['session_delete', 'agent'],
    ['session_suggestion_update', 'agent'],
    ['session_suggestion_dismiss', 'agent'],
    ['explore', 'other'],
    ['skill', 'other'],
    ['ask_user', 'other'],
    ['request_directory', 'other'],
    ['screen_capture', 'other'],
    ['memory_delete', 'other'],
    ['generate_image', 'other'],
    ['generate_speech', 'other'],
    ['generate_sound_effect', 'other'],
    ['generate_music', 'other'],
    ['generate_video', 'other'],
    ['mcp_reconnect_server', 'other'],
    ['mcp_set_server_enabled', 'other'],
    ['mcp_remove_server', 'other'],
    ['mcp_add_server', 'other'],
    ['mcp_update_server', 'other'],
  ];

  it.each(table)('%s is %s', (name, kind) => {
    expect(toolKind(name)).toBe(kind);
  });

  it('is case-insensitive', () => {
    expect(toolKind('File_Edit')).toBe('edit');
  });
});

describe('activityLabel', () => {
  it('names a tool and its detail, trimming when there is none', () => {
    expect(activityLabel({ kind: 'tool', tool: 'file_edit', detail: 'X.ts' })).toBe('file_edit X.ts');
    expect(activityLabel({ kind: 'tool', tool: 'file_edit', detail: '' })).toBe('file_edit');
  });

  it('words each phase', () => {
    expect(activityLabel({ kind: 'phase', phase: 'waiting' })).toBe('Waiting on the model');
    expect(activityLabel({ kind: 'phase', phase: 'thinking' })).toBe('Thinking');
    expect(activityLabel({ kind: 'phase', phase: 'responding' })).toBe('Writing a reply');
    expect(activityLabel({ kind: 'phase', phase: 'writing-tool', tool: 'file_write' })).toBe('Preparing file_write');
  });
});
