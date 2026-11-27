import { PassThrough } from 'node:stream';
import type { AxiosInstance } from 'axios';
import type { SessionTurnStreamEvent } from '@bike4mind/common';
import { webQuestMessageId } from '@shared/claudeImport';
import { describe, expect, it, vi } from 'vitest';
import { mapQuests } from '../claudeImport/webSessionMapper';
import {
  LinkedReplySlots,
  SessionTurnDroppedError,
  SessionTurnRequestError,
  parseSessionTurnFrame,
  sessionTurnsEndpoint,
  streamSessionTurn,
} from './webLinkedTurn';

const frame = (payload: unknown) => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;

const body = { session_id: 'nb1', message: 'hello', model: 'claude-sonnet' };

function streamingAxios(frames: string[]): { axios: AxiosInstance; post: ReturnType<typeof vi.fn> } {
  const post = vi.fn(async () => {
    const stream = new PassThrough();
    setImmediate(() => {
      for (const text of frames) stream.write(text);
      stream.end();
    });
    return { data: stream, status: 200 };
  });
  return { axios: { post } as unknown as AxiosInstance, post };
}

describe('webQuestMessageId', () => {
  it('names the messages exactly as the web importer does', () => {
    const { messages } = mapQuests(
      [{ id: 'q1', prompt: 'hi', reply: 'hello', type: 'message', status: 'done' }],
      '2026-01-01T00:00:00.000Z'
    );
    expect(messages.map(message => message.id)).toEqual([webQuestMessageId('q1', 'p'), webQuestMessageId('q1', 'r')]);
  });
});

describe('sessionTurnsEndpoint', () => {
  it('follows the completions origin on a self-host stack and is same-origin otherwise', () => {
    expect(sessionTurnsEndpoint('/api/ai/v1/completions')).toBe('/api/v1/turns');
    expect(sessionTurnsEndpoint('https://chat.example.test/api/ai/v1/completions')).toBe(
      'https://chat.example.test/api/v1/turns'
    );
    expect(sessionTurnsEndpoint('https://chat.example.test/other')).toBe('/api/v1/turns');
  });
});

describe('LinkedReplySlots', () => {
  it('appends deltas and shows the visible text of every slot', () => {
    const slots = new LinkedReplySlots();
    expect(slots.apply({ type: 'delta', slot: 0, text: 'Hello' })).toBe('Hello');
    expect(slots.apply({ type: 'delta', slot: 0, text: ' world' })).toBe(' world');
    expect(slots.text).toBe('Hello world');
  });

  it('leaves thinking out of the shown text', () => {
    const slots = new LinkedReplySlots();
    expect(slots.apply({ type: 'delta', slot: 0, text: '<think>pondering</think>' })).toBeNull();
    expect(slots.apply({ type: 'delta', slot: 1, text: 'Answer' })).toBe('Answer');
    expect(slots.text).toBe('Answer');
  });

  it('holds a replace that rewrites shown text for the final reply instead of appending it', () => {
    const slots = new LinkedReplySlots();
    slots.apply({ type: 'delta', slot: 0, text: 'First try' });
    expect(slots.apply({ type: 'replace', slot: 0, text: 'Second' })).toBeNull();
    expect(slots.text).toBe('Second');
  });
});

describe('parseSessionTurnFrame', () => {
  it('reads the contract events and skips anything else', () => {
    expect(parseSessionTurnFrame(JSON.stringify({ type: 'turn', quest_id: 'q', session_id: 's' }))).toEqual({
      type: 'turn',
      quest_id: 'q',
      session_id: 's',
    });
    expect(parseSessionTurnFrame('not json')).toBeNull();
    expect(parseSessionTurnFrame(JSON.stringify({ type: 'turn' }))).toBeNull();
  });
});

describe('streamSessionTurn', () => {
  it('hands over each event until [DONE]', async () => {
    const { axios, post } = streamingAxios([
      frame({ type: 'meta', requestId: 'r1' }),
      frame({ type: 'turn', quest_id: 'q1', session_id: 'nb1' }),
      frame({ type: 'delta', quest_id: 'q1', slot: 0, text: 'Hi' }),
      frame({ type: 'replace', quest_id: 'q1', slot: 0, text: 'Hey' }),
      frame({ type: 'settled', quest_id: 'q1', status: 'done', failed: false }),
      frame('[DONE]'),
      frame({ type: 'delta', quest_id: 'q1', slot: 0, text: 'late' }),
    ]);
    const events: SessionTurnStreamEvent[] = [];
    await streamSessionTurn(axios, '/api/v1/turns', body, event => events.push(event));

    expect(post).toHaveBeenCalledWith('/api/v1/turns', body, expect.objectContaining({ responseType: 'stream' }));
    expect(events.map(event => event.type)).toEqual(['meta', 'turn', 'delta', 'replace', 'settled']);
  });

  it('treats a stream that ends without settled or [DONE] as a dropped connection', async () => {
    const { axios } = streamingAxios([
      frame({ type: 'turn', quest_id: 'q1', session_id: 'nb1' }),
      frame({ type: 'delta', quest_id: 'q1', slot: 0, text: 'Hi' }),
    ]);
    await expect(streamSessionTurn(axios, '/api/v1/turns', body, () => undefined)).rejects.toBeInstanceOf(
      SessionTurnDroppedError
    );
  });

  it('accepts a settled turn whose stream ends before [DONE]', async () => {
    const { axios } = streamingAxios([
      frame({ type: 'turn', quest_id: 'q1', session_id: 'nb1' }),
      frame({ type: 'settled', quest_id: 'q1', status: 'done', failed: false }),
    ]);
    await expect(streamSessionTurn(axios, '/api/v1/turns', body, () => undefined)).resolves.toBeUndefined();
  });

  it('rejects with the server message on an error frame', async () => {
    const { axios } = streamingAxios([
      frame({ type: 'turn', quest_id: 'q1', session_id: 'nb1' }),
      frame({ type: 'error', message: 'Provider overloaded' }),
    ]);
    await expect(streamSessionTurn(axios, '/api/v1/turns', body, () => undefined)).rejects.toThrow(
      'Provider overloaded'
    );
  });

  it('turns a pre-stream JSON refusal into its message and status', async () => {
    const refused = Object.assign(new Error('Request failed with status code 400'), {
      isAxiosError: true,
      response: { status: 400, data: JSON.stringify({ message: 'Unknown model', errorCode: 'invalid_model' }) },
    });
    const axios = { post: vi.fn().mockRejectedValue(refused) } as unknown as AxiosInstance;

    const failure = await streamSessionTurn(axios, '/api/v1/turns', body, () => undefined).catch(error => error);

    expect(failure).toBeInstanceOf(SessionTurnRequestError);
    expect(failure).toMatchObject({ message: 'Unknown model (status 400)', status: 400, errorCode: 'invalid_model' });
  });
});
