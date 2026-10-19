import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@shared/chat';
import { appendArrived, OPTIMISTIC_ID_PREFIX } from './arrivedMessage';

function message(id: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: 'user', content: id, createdAt: '', ...extra };
}

describe('appendArrived', () => {
  const boundary = message('boundary', { system: true, boundary: { kind: 'compact', automatic: true } });

  it('puts a boundary above the prompt still waiting to be stored', () => {
    const optimistic = message(`${OPTIMISTIC_ID_PREFIX}1`);
    const ids = appendArrived([message('stored'), optimistic], boundary).map(entry => entry.id);
    expect(ids).toEqual(['stored', 'boundary', optimistic.id]);
  });

  it('appends a boundary when nothing is waiting', () => {
    expect(appendArrived([message('stored')], boundary).map(entry => entry.id)).toEqual(['stored', 'boundary']);
  });

  it('appends any other arrival at the end', () => {
    const report = message('report', { system: true });
    const optimistic = message(`${OPTIMISTIC_ID_PREFIX}1`);
    expect(appendArrived([optimistic], report).map(entry => entry.id)).toEqual([optimistic.id, 'report']);
  });
});
