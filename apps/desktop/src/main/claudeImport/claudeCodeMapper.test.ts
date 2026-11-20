import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@shared/chat';
import { activeTodos } from '@shared/todos';
import { applyCodeEvent, tidyMessages, type CodeMapState } from './claudeCodeMapper';

let seq = 0;
const base = () => ({ uuid: `e-${++seq}`, sessionId: 's', timestamp: '2026-01-02T10:00:00.000Z', isSidechain: false });
const user = (text: string) => ({ ...base(), type: 'user', message: { role: 'user', content: text } });
const assistant = (messageId: string, block: Record<string, unknown>) => ({
  ...base(),
  type: 'assistant',
  message: { id: messageId, role: 'assistant', content: [block], stop_reason: 'tool_use' },
});
const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });
const result = (id: string, text: string) => ({
  ...base(),
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
});

function importEvents(events: unknown[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const state: CodeMapState = {};
  for (const event of events) applyCodeEvent(event, messages, state, []);
  return tidyMessages(messages);
}

describe('an imported Claude Code transcript that plans with TaskCreate / TaskUpdate', () => {
  const events = [
    user('Fix the build'),
    assistant('m1', use('t1', 'TaskCreate', { subject: 'Read the logs', activeForm: 'Reading the logs' })),
    result('t1', 'Task #1 created successfully: Read the logs'),
    assistant('m2', use('t2', 'TaskCreate', { subject: 'Patch the config', activeForm: 'Patching the config' })),
    result('t2', 'Task #7 created successfully: Patch the config'),
    assistant('m3', use('t3', 'TaskCreate', { subject: 'Try a rewrite' })),
    result('t3', 'Task #3 created successfully: Try a rewrite'),
    assistant('m4', { type: 'text', text: 'Plan is set.' }),
    user('go ahead'),
    assistant('m5', use('t4', 'TaskUpdate', { taskId: '1', status: 'completed' })),
    result('t4', 'Updated task #1 status'),
    assistant('m6', use('t5', 'TaskUpdate', { taskId: '7', status: 'in_progress' })),
    result('t5', 'Updated task #2 status'),
    assistant('m7', use('t6', 'TaskUpdate', { taskId: '3', status: 'cancelled' })),
    result('t6', 'Updated task #3 status'),
  ];

  it('yields the folded plan for the panel', () => {
    expect(activeTodos(importEvents(events), false)).toEqual([
      { id: '1', content: 'Read the logs', activeForm: 'Reading the logs', status: 'completed' },
      { id: '7', content: 'Patch the config', activeForm: 'Patching the config', status: 'in_progress' },
      { id: '3', content: 'Try a rewrite', status: 'cancelled' },
    ]);
  });

  it('shows no plan once a later reply no longer touches it', () => {
    const later = [...events, user('thanks'), assistant('m8', { type: 'text', text: 'You are welcome.' })];
    expect(activeTodos(importEvents(later), false)).toBeNull();
  });
});
