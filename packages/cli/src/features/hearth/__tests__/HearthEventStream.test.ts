import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HearthEventStream } from '../HearthEventStream.js';
import type { HearthEvent } from '../types.js';
import type { WebSocketConnectionManager } from '../../../ws/WebSocketConnectionManager.js';

type Handler = (message: unknown) => void;

function createMockWsManager() {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    manager: {
      onAction: vi.fn((action: string, handler: Handler) => handlers.set(action, handler)),
      offAction: vi.fn((action: string) => handlers.delete(action)),
    } as unknown as WebSocketConnectionManager,
  };
}

const validEvent = {
  id: 'ev-1',
  channelId: 'ch-1',
  seq: 7,
  actorId: 'actor-1',
  kind: 'message',
  human: { text: 'hello', format: 'md' },
  refs: {},
  createdAt: '2026-07-20T12:00:00Z',
};

describe('HearthEventStream', () => {
  let onEvent: ReturnType<typeof vi.fn<(event: HearthEvent) => void>>;
  let stream: HearthEventStream;

  beforeEach(() => {
    onEvent = vi.fn<(event: HearthEvent) => void>();
    stream = new HearthEventStream(onEvent);
  });

  it('subscribes to hearth_event and forwards parsed events', () => {
    const { handlers, manager } = createMockWsManager();
    stream.registerHandlers(manager);

    handlers.get('hearth_event')!({ event: validEvent });

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ id: 'ev-1', seq: 7 }));
  });

  it('ignores messages with no event field', () => {
    const { handlers, manager } = createMockWsManager();
    stream.registerHandlers(manager);

    handlers.get('hearth_event')!({});
    handlers.get('hearth_event')!({ entry: validEvent });

    expect(onEvent).not.toHaveBeenCalled();
  });

  it('ignores events that fail schema validation', () => {
    const { handlers, manager } = createMockWsManager();
    stream.registerHandlers(manager);

    handlers.get('hearth_event')!({ event: { ...validEvent, seq: 'not-a-number' } });
    handlers.get('hearth_event')!({ event: { ...validEvent, human: undefined } });

    expect(onEvent).not.toHaveBeenCalled();
  });

  it('disposes the previous registration before re-registering (hot-reload path)', () => {
    const first = createMockWsManager();
    const second = createMockWsManager();

    stream.registerHandlers(first.manager);
    stream.registerHandlers(second.manager);

    expect(first.manager.offAction).toHaveBeenCalledWith('hearth_event');
    expect(second.manager.onAction).toHaveBeenCalledWith('hearth_event', expect.any(Function));
  });

  it('dispose unsubscribes and is idempotent', () => {
    const { manager } = createMockWsManager();
    stream.registerHandlers(manager);

    stream.dispose();
    stream.dispose();

    expect(manager.offAction).toHaveBeenCalledTimes(1);
    expect(manager.offAction).toHaveBeenCalledWith('hearth_event');
  });
});
