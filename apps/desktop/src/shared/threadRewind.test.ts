import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatToolCall } from './chat';
import { formatModelEditNote } from './modelEdit';
import {
  carriedNotes,
  changedThings,
  editWarnings,
  isTypedPrompt,
  promptHistory,
  regenerableReply,
  turnsChangedThings,
  typedText,
} from './threadRewind';

const at = '2026-11-01T00:00:00.000Z';
const user = (id: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role: 'user',
  content: id,
  createdAt: at,
  ...extra,
});
const reply = (id: string, calls: Partial<ChatToolCall>[] = []): ChatMessage => ({
  id,
  role: 'assistant',
  content: id,
  createdAt: at,
  ...(calls.length
    ? {
        toolCalls: calls.map((call, index) => ({
          id: `${id}-${index}`,
          name: 'x',
          input: {},
          status: 'done',
          ...call,
        })),
      }
    : {}),
});

describe('changedThings', () => {
  it('counts file writes, edits, patches and shell runs that ran', () => {
    for (const name of ['file_write', 'file_edit', 'apply_patch', 'bash_execute', 'bash_background']) {
      expect(changedThings({ name, status: 'done' })).toBe(true);
    }
    // A shell command can write before it fails.
    expect(changedThings({ name: 'bash_execute', status: 'error' })).toBe(true);
  });

  it('ignores read-only tools and calls that never ran', () => {
    for (const name of ['file_read', 'grep_search', 'glob_files', 'bash_output', 'bash_list', 'web_fetch']) {
      expect(changedThings({ name, status: 'done' })).toBe(false);
    }
    for (const status of ['denied', 'awaiting-approval', 'moved'] as const) {
      expect(changedThings({ name: 'file_write', status })).toBe(false);
    }
  });
});

describe('turnsChangedThings', () => {
  it('is true only when a dropped turn ran a tool that changed things', () => {
    expect(turnsChangedThings([reply('a', [{ name: 'file_read' }])])).toBe(false);
    expect(turnsChangedThings([reply('a', [{ name: 'file_read' }]), reply('b', [{ name: 'file_edit' }])])).toBe(true);
    expect(turnsChangedThings([])).toBe(false);
  });
});

describe('editWarnings', () => {
  it('warns about later turns, and about changes only when a later turn made one', () => {
    const messages = [
      user('u1'),
      reply('a1', [{ name: 'file_write' }]),
      user('u2'),
      reply('a2', [{ name: 'grep_search' }]),
      user('u3'),
    ];
    const warnings = editWarnings(messages);
    expect(warnings.get('u1')).toBe('changes');
    expect(warnings.get('u2')).toBe('later');
    expect(warnings.get('u3')).toBe('none');
  });

  it('offers no edit on text the app wrote in the user role', () => {
    const messages = [
      user('relay', { system: true, relay: { fromSessionId: 's', fromTitle: 't', hops: 1 } as never }),
      user('marker', { boundary: { kind: 'clear' } }),
      user('seed', { seed: true }),
      user('typed'),
    ];
    expect([...editWarnings(messages).keys()]).toEqual(['typed']);
  });
});

describe('isTypedPrompt and typedText', () => {
  it('reads a skill turn back as its invocation, not the expanded body', () => {
    const skill = user('s', {
      content: 'a long SKILL.md body',
      skill: { name: 'review', source: 'user', args: 'src/a.ts' } as never,
    });
    expect(isTypedPrompt(skill)).toBe(true);
    expect(typedText(skill)).toBe('/review src/a.ts');
    expect(isTypedPrompt(reply('a'))).toBe(false);
  });
});

describe('carriedNotes', () => {
  it('keeps the point-and-edit note and drops notes main writes for the turn', () => {
    const modelEdit = formatModelEditNote({
      path: 'model.ts',
      units: 'mm',
      parts: [{ name: 'lid', lines: [3], min: [0, 0, 0], max: [1, 1, 1] }],
      sharedLines: [],
      closeup: 'shot.png',
    });
    const prompt = user('u1', { notes: ['Run the /review skill.', modelEdit, 'The task was closed.'] });
    expect(carriedNotes(prompt)).toEqual([modelEdit]);
    expect(carriedNotes(user('u2'))).toEqual([]);
  });
});

describe('regenerableReply', () => {
  it('is the last message when it is a reply to a prompt', () => {
    expect(regenerableReply([user('u1'), reply('a1')])?.id).toBe('a1');
    expect(regenerableReply([user('u1')])).toBeNull();
    expect(regenerableReply([reply('a1')])).toBeNull();
    expect(regenerableReply([])).toBeNull();
  });
});

describe('promptHistory', () => {
  it('lists typed prompts newest first, skipping app-written ones and repeats of the one before', () => {
    const messages = [
      user('one'),
      reply('a'),
      user('two'),
      user('auto', { system: true, automatic: { kind: 'auto-fix' } as never }),
      user('two', { id: 'two-again' }),
      reply('b'),
      user('', { id: 'empty', attachments: [] }),
    ];
    expect(promptHistory(messages)).toEqual(['two', 'one']);
  });
});
