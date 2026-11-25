import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatSessionStatusEvent, ChatStreamEvent } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import { SessionActivity } from './SessionActivity';
import { SessionStore } from './SessionStore';
import type { ModelCatalog } from './ModelCatalog';
import type { AccessStore } from './tools/AccessStore';

describe('childWaiting', () => {
  let service: ChatService;
  let store: SessionStore;
  let activity: SessionActivity;
  const events: ChatSessionStatusEvent[] = [];

  beforeEach(async () => {
    events.length = 0;
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-child-waiting-')), 'test-model');
    activity = new SessionActivity(event => events.push(event));
    service = new ChatService({
      store,
      activity,
      access: { list: async () => [] } as unknown as AccessStore,
      models: {
        list: async () => ({ models: [{ id: 'test-model', name: 'Test', backend: 'openai' }] }),
        cached: () => [],
      } as unknown as ModelCatalog,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () => null,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: () => undefined,
    });
  });

  afterEach(() => service.dispose());

  async function parkedChild(command: string) {
    const parent = await store.create();
    const child = await store.create(undefined, {
      origin: { parentSessionId: parent.id, depth: 1, seedPrompt: 'review the PR' },
    });
    await store.appendMessage(child.id, {
      id: 'reply-1',
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
      toolCalls: [{ id: 'call-1', name: 'bash', input: { command }, status: 'awaiting-approval', approvalId: 'a1' }],
    });
    return { parent, child };
  }

  const noticesIn = async (parentId: string) =>
    ((await store.get(parentId))?.messages ?? []).filter(message => message.system);

  it('names the waiting child and the call it is parked on, so the thread can fold it into one card', async () => {
    const { parent, child } = await parkedChild('gh pr merge 12');
    activity.approvalRequested(child.id);
    service.sessionStatusChanged(events.at(-1)!);

    await vi.waitFor(async () => expect(await noticesIn(parent.id)).toHaveLength(1));
    const [notice] = await noticesIn(parent.id);
    expect(notice?.childWaiting).toEqual({ sessionId: child.id, reason: 'approval', summary: 'bash gh pr merge 12' });
    // The model's copy is unchanged.
    expect(notice?.content).toContain('is waiting on the user for an approval');
  });

  it('names a call parked in a turn still in flight, before the turn stores it', async () => {
    const parent = await store.create();
    const child = await store.create(undefined, {
      origin: { parentSessionId: parent.id, depth: 1, seedPrompt: 'review the PR' },
    });
    // The turn's live events, as trackLive keeps them; nothing is stored until the turn settles.
    const call = { id: 'call-9', name: 'bash', input: { command: 'gh pr checks 7' } };
    (service as unknown as { live: Map<string, { events: ChatStreamEvent[] }> }).live.set(child.id, {
      events: [
        {
          type: 'tool-start',
          sessionId: child.id,
          messageId: 'm',
          call: { ...call, status: 'awaiting-approval', approvalId: 'a9' },
        },
      ],
    });
    activity.approvalRequested(child.id);
    service.sessionStatusChanged(events.at(-1)!);

    await vi.waitFor(async () => expect(await noticesIn(parent.id)).toHaveLength(1));
    expect((await noticesIn(parent.id))[0]?.childWaiting?.summary).toBe('bash gh pr checks 7');
  });

  it('leaves one notice per wait, not per status event', async () => {
    const { parent, child } = await parkedChild('pnpm test');
    activity.approvalRequested(child.id);
    service.sessionStatusChanged(events.at(-1)!);
    service.sessionStatusChanged(events.at(-1)!);
    await vi.waitFor(async () => expect(await noticesIn(parent.id)).toHaveLength(1));

    // Answered, then a second ask: a second notice for the same child.
    activity.approvalSettled(child.id);
    service.sessionStatusChanged(events.at(-1)!);
    activity.approvalRequested(child.id);
    service.sessionStatusChanged(events.at(-1)!);
    await vi.waitFor(async () => expect(await noticesIn(parent.id)).toHaveLength(2));
    expect((await noticesIn(parent.id)).map(notice => notice.childWaiting?.sessionId)).toEqual([child.id, child.id]);
  });
});
