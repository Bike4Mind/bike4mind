import { describe, expect, it } from 'vitest';
import { isImportedMessageId, normalizeImportOrigin } from '@shared/claudeImport';
import { mapQuests, readNotebook } from './webSessionMapper';

const AT = '2026-01-01T00:00:00.000Z';

describe('readNotebook', () => {
  it('reads id, name and timestamps, and versions on both update stamps', () => {
    const notebook = readNotebook({
      id: '65a1b2c3d4e5f60718293a4b',
      name: ' Trip plan ',
      firstCreated: '2026-01-01T00:00:00Z',
      lastUpdated: '2026-01-02T00:00:00Z',
      updatedAt: '2026-01-03T00:00:00Z',
    });
    expect(notebook).toEqual({
      id: '65a1b2c3d4e5f60718293a4b',
      name: 'Trip plan',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-03T00:00:00.000Z',
      version: '2026-01-03T00:00:00.000Z|2026-01-02T00:00:00.000Z',
    });
  });

  it('rejects rows without a safe id', () => {
    expect(readNotebook({ id: '../etc', name: 'x' })).toBeNull();
    expect(readNotebook({ name: 'x' })).toBeNull();
    expect(readNotebook(null)).toBeNull();
  });
});

describe('mapQuests', () => {
  it('maps each quest to its prompt and reply with stable imported ids', () => {
    const { messages, settled } = mapQuests(
      [
        { id: 'q1', type: 'message', prompt: 'Hi', reply: 'Hello', timestamp: '2026-01-01T00:00:01Z', status: 'done' },
        { id: 'q2', type: 'message', prompt: 'More', replies: ['', 'Sure'], timestamp: '2026-01-01T00:00:02Z' },
        { id: 'q3', type: 'system', prompt: 'internal', reply: 'x' },
        { id: 'q1', type: 'message', prompt: 'dup', reply: 'dup' },
      ],
      AT
    );
    expect(settled).toBe(true);
    expect(messages.map(message => [message.id, message.role, message.content])).toEqual([
      ['bw-q1-p', 'user', 'Hi'],
      ['bw-q1-r', 'assistant', 'Hello'],
      ['bw-q2-p', 'user', 'More'],
      ['bw-q2-r', 'assistant', 'Sure'],
    ]);
    expect(messages[1].rounds).toEqual([{ text: 'Hello', toolCallIds: [] }]);
    expect(messages.every(message => isImportedMessageId(message.id))).toBe(true);
  });

  it('reports a running reply as unsettled and keeps its prompt', () => {
    const { messages, settled } = mapQuests([{ id: 'q1', prompt: 'Wait', status: 'running' }], AT);
    expect(settled).toBe(false);
    expect(messages).toHaveLength(1);
    expect(messages[0].createdAt).toBe(AT);
  });
});

describe('b4m-web import origin', () => {
  it('is a recognised import kind', () => {
    expect(normalizeImportOrigin({ kind: 'b4m-web', sourceId: 'abc' })).toMatchObject({ kind: 'b4m-web' });
  });
});
