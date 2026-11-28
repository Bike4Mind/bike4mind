// @vitest-environment jsdom
import { chatBackedHostBridge } from '../../../__fixtures__/chatBackedHostBridge';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatToolCall } from '@shared/chat';
import type { PendingDecision } from '@shared/pendingDecisions';
import { agentFixture, createThemedMount, el, query } from '../testUtils';
import { SceneDialogue } from './SceneDialogue';
import { inSceneDialogue } from './dialogue';

const decisions = vi.hoisted(() => ({ byId: new Map<string, PendingDecision[]>() }));
vi.mock('../useTreeDecisions', () => ({
  useTreeDecisions: () => ({ byId: decisions.byId, loadError: null, refresh: vi.fn() }),
}));

const chat = { respondToApproval: vi.fn(), answerTaskDecision: vi.fn(), resolveHeldRelay: vi.fn() };
const onOpenDetails = vi.fn();
const onFrontChange = vi.fn();
const themed = createThemedMount('dark');

const approval = (sessionId: string, id: string, extra: Partial<ChatToolCall> = {}): PendingDecision => ({
  kind: 'approval',
  sessionId,
  decisionId: `approval:${id}`,
  approvalId: id,
  call: {
    id: `c-${id}`,
    name: 'bash_execute',
    input: { command: `echo ${id}` },
    status: 'awaiting-approval',
    approvalId: id,
    ...extra,
  },
  collectsSecrets: false,
});

const render = (frontKey?: string, focusRequest?: number) =>
  themed.render(
    <SceneDialogue
      agents={[agentFixture('a', 'needs-you'), agentFixture('b', 'needs-you')]}
      nameOf={id => `Agent ${id}`}
      portraitOf={() => ({ src: 'data:image/png;base64,' })}
      frontKey={frontKey}
      onFrontChange={onFrontChange}
      onOpenDetails={onOpenDetails}
      focusRequest={focusRequest}
      look="wood"
    />
  );

const press = async (key: string) =>
  act(async () => {
    el('scene-dialogue').dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });

const button = (testId: string) => el(testId) as HTMLButtonElement;

beforeEach(() => {
  vi.clearAllMocks();
  chat.respondToApproval.mockResolvedValue(undefined);
  (window as unknown as { b4m: unknown }).b4m = { host: chatBackedHostBridge(), chat };
  decisions.byId = new Map([
    ['a', [approval('a', 'p1')]],
    ['b', [approval('b', 'p2')]],
  ]);
});

afterEach(() => {
  themed.unmount();
  vi.restoreAllMocks();
});

describe('SceneDialogue', () => {
  it('renders nothing with no open decision', async () => {
    decisions.byId = new Map();
    await render();
    expect(query('scene-dialogue')).toBeNull();
  });

  it('shows the front request with its full command and the queue position', async () => {
    await render();
    expect(el('scene-dialogue-name').textContent).toContain('Agent a');
    expect(el('scene-dialogue-code').textContent).toContain('echo p1');
    expect(el('scene-dialogue-position').textContent).toBe('1 of 2');
  });

  it('answers by key: A once, C for the chat, D deny', async () => {
    await render();
    await press('a');
    expect(chat.respondToApproval).toHaveBeenLastCalledWith('p1', { decision: 'once' });
    // The answered request leaves at once and the next comes forward.
    expect(el('scene-dialogue-code').textContent).toContain('echo p2');
    await press('c');
    expect(chat.respondToApproval).toHaveBeenLastCalledWith('p2', { decision: 'always' });
  });

  it('denies by key', async () => {
    await render();
    await press('d');
    expect(chat.respondToApproval).toHaveBeenCalledWith('p1', { decision: 'deny' });
  });

  it('moves through the queue with the arrows', async () => {
    await render();
    await press('ArrowRight');
    expect(onFrontChange).toHaveBeenLastCalledWith('b:approval:p2');
  });

  it('lets a long command be allowed at once, without scrolling to the end', async () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100);
    await render();
    expect(button('scene-dialogue-allow-once').disabled).toBe(false);
    expect(button('scene-dialogue-allow-chat').disabled).toBe(false);
    expect(el('scene-dialogue').textContent).not.toContain('Read to the end');
    await press('a');
    expect(chat.respondToApproval).toHaveBeenCalledWith('p1', { decision: 'once' });
  });

  it('allows in this chat by key on first render', async () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100);
    await render();
    await press('c');
    expect(chat.respondToApproval).toHaveBeenCalledWith('p1', { decision: 'always' });
  });

  it('leaves A and C alone while typing in a field inside the box', async () => {
    await render();
    const field = document.createElement('input');
    el('scene-dialogue').appendChild(field);
    await act(async () => {
      for (const key of ['a', 'c']) field.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    });
    expect(chat.respondToApproval).not.toHaveBeenCalled();
    field.remove();
  });

  it('hides Allow in this chat for a once-only approval', async () => {
    decisions.byId = new Map([['a', [approval('a', 'p1', { approvalOnceOnly: true })]]]);
    await render();
    expect(query('scene-dialogue-allow-chat')).toBeNull();
    await press('c');
    expect(chat.respondToApproval).not.toHaveBeenCalled();
  });

  it('keeps the full card for an approval it does not restyle', async () => {
    decisions.byId = new Map([['a', [approval('a', 'p1', { approvalIrreversible: true })]]]);
    await render();
    expect(query('scene-dialogue-command')).toBeNull();
    expect(query('scene-dialogue-card')).not.toBeNull();
    await press('a');
    expect(chat.respondToApproval).not.toHaveBeenCalled();
  });

  it('opens the session and minimizes by key', async () => {
    await render();
    await press('o');
    expect(onOpenDetails).toHaveBeenCalledWith('a');
    await press('Escape');
    expect(query('scene-dialogue')).toBeNull();
    expect(query('scene-dialogue-minimized')).not.toBeNull();
  });

  it('comes back from the minimized tab and takes focus on a focus request', async () => {
    await render();
    await press('Escape');
    expect(query('scene-dialogue')).toBeNull();
    await render(undefined, 1);
    expect(document.activeElement).toBe(el('scene-dialogue'));
  });

  it('keeps the front request among the queue portraits when it is past the first five', async () => {
    decisions.byId = new Map([['a', ['1', '2', '3', '4', '5', '6', '7'].map(id => approval('a', `q${id}`))]]);
    await render('a:approval:q6');
    expect(el('scene-dialogue-position').textContent).toBe('6 of 7');
    const queue = el('scene-dialogue-queue');
    expect(queue.querySelectorAll('button[aria-current="true"]')).toHaveLength(1);
    expect(queue.textContent).toContain('+2');
  });

  it('marks the box so the settle-key handler leaves its keys alone', async () => {
    await render();
    expect(inSceneDialogue(el('scene-dialogue-code'))).toBe(true);
    expect(inSceneDialogue(document.body)).toBe(false);
  });

  it('brings a clicked character forward by session id', async () => {
    await render('b');
    expect(el('scene-dialogue-code').textContent).toContain('echo p2');
  });
});
