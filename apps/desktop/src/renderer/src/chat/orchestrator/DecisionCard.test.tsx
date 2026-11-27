// @vitest-environment jsdom
import { chatBackedHostBridge } from '../../__fixtures__/chatBackedHostBridge';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatToolCall } from '@shared/chat';
import type { PendingDecision } from '@shared/pendingDecisions';
import { DecisionBody, DecisionCard } from './DecisionCard';
import { createThemedMount, el, query } from './testUtils';

const chat = {
  respondToApproval: vi.fn(),
  answerTaskDecision: vi.fn(),
  resolveHeldRelay: vi.fn(),
  regenerateReply: vi.fn(),
  continueReply: vi.fn(),
};
const onOpenDetails = vi.fn();
const onSettled = vi.fn();
const themed = createThemedMount();
const asker = { name: 'Ada', path: ['Quest', 'Bo', 'Ada'] };

const render = (decision: PendingDecision) =>
  themed.render(<DecisionCard decision={decision} asker={asker} onOpenDetails={onOpenDetails} onSettled={onSettled} />);

const call = (name: string): ChatToolCall => ({
  id: 'c1',
  name,
  input: { command: 'rm -rf build' },
  status: 'awaiting-approval',
  approvalId: 'ap1',
});

beforeEach(() => {
  vi.clearAllMocks();
  chat.respondToApproval.mockResolvedValue(undefined);
  chat.answerTaskDecision.mockResolvedValue(undefined);
  chat.resolveHeldRelay.mockResolvedValue(undefined);
  (window as unknown as { b4m: unknown }).b4m = { host: chatBackedHostBridge(), chat };
});

afterEach(() => themed.unmount());

describe('DecisionCard', () => {
  it('names who asked and the path down to it', async () => {
    await render({ kind: 'error', sessionId: 'g', decisionId: 'error:r', messageId: 'r', error: 'boom' });
    expect(el('decision-card-asker').textContent).toBe('Ada');
    expect(el('decision-card-path').textContent).toBe('Quest > Bo > Ada');
    await act(async () => el('decision-card-open-btn').click());
    expect(onOpenDetails).toHaveBeenCalledWith('g');
  });

  it('answers a tool approval with the thread card and the approval IPC', async () => {
    await render({
      kind: 'approval',
      sessionId: 'g',
      decisionId: 'approval:ap1',
      approvalId: 'ap1',
      call: call('bash_execute'),
      collectsSecrets: false,
    });
    await act(async () => el('chat-tool-approve-once').click());
    expect(chat.respondToApproval).toHaveBeenCalledWith('ap1', { decision: 'once' });
    expect(query('decision-card')).toBeNull();
    expect(onSettled).toHaveBeenCalled();
  });

  it('keeps the card with the error when the approval cannot be delivered', async () => {
    chat.respondToApproval.mockRejectedValue(new Error('gate gone'));
    await render({
      kind: 'approval',
      sessionId: 'g',
      decisionId: 'approval:ap1',
      approvalId: 'ap1',
      call: call('bash_execute'),
      collectsSecrets: false,
    });
    await act(async () => el('chat-tool-approve-once').click());
    expect(el('orchestrator-peek-pending-error').textContent).toBe('gate gone');
    expect(query('decision-card')).not.toBeNull();
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('sends a request that collects secrets to the agent details instead of drawing the fields', async () => {
    await render({
      kind: 'approval',
      sessionId: 'g',
      decisionId: 'approval:ap1',
      approvalId: 'ap1',
      call: call('mcp_add_server'),
      collectsSecrets: true,
    });
    expect(query('mcp-request-card')).toBeNull();
    await act(async () => el('decision-card-review-btn').click());
    expect(onOpenDetails).toHaveBeenCalledWith('g');
  });

  it('answers a task question through answerTaskDecision', async () => {
    await render({
      kind: 'question',
      sessionId: 'g',
      decisionId: 'question:d1',
      decision: {
        id: 'd1',
        askedAt: '2026-10-01',
        question: {
          header: 'Branch',
          question: 'Which branch?',
          options: [
            { label: 'main', description: 'The default' },
            { label: 'develop', description: 'Next' },
          ],
        },
      },
    });
    await act(async () => el('chat-question-skip').click());
    expect(chat.answerTaskDecision).toHaveBeenCalledWith('g', 'd1', { status: 'skipped' });
  });

  it('delivers a held relay to the session that holds it, then refetches', async () => {
    await render({
      kind: 'held-relay',
      sessionId: 'g',
      decisionId: 'held:h1',
      held: {
        id: 'h1',
        sessionId: 'g',
        text: 'merge it',
        heldAt: '2026-10-01',
        reason: 'looser-mode',
        relay: { fromSessionId: 'x', fromTitle: 'Sender', hops: 1 },
      },
    });
    await act(async () => el('held-relay-decline-btn').click());
    expect(chat.resolveHeldRelay).toHaveBeenCalledWith('g', 'h1', false);
    expect(onSettled).toHaveBeenCalled();
  });

  it('retries a failed turn once, and stays quiet when another surface already started it', async () => {
    chat.regenerateReply.mockResolvedValue({ ok: false, error: 'This conversation is still replying.', busy: true });
    await render({ kind: 'error', sessionId: 'g', decisionId: 'error:r', messageId: 'r', error: 'boom' });
    await act(async () => el('decision-card-retry-btn').click());
    expect(chat.regenerateReply).toHaveBeenCalledWith('g');
    expect(query('decision-card-error')).toBeNull();
    expect(onSettled).toHaveBeenCalled();
  });

  it('shows a refusal that is not a turn already running', async () => {
    chat.continueReply.mockResolvedValue({ ok: false, error: 'Sign in to continue this reply.' });
    await render({
      kind: 'stopped',
      sessionId: 'g',
      decisionId: 'stopped:r',
      messageId: 'r',
      stopReason: 'tool_turn_limit',
    });
    await act(async () => el('decision-card-continue-btn').click());
    expect(chat.continueReply).toHaveBeenCalledWith('g');
    expect(el('decision-card-error').textContent).toBe('Sign in to continue this reply.');
  });

  it('keeps Continue disabled once the turn started, until the refetch drops the card', async () => {
    chat.continueReply.mockResolvedValue({ ok: true, messageId: 'r' });
    await render({
      kind: 'stopped',
      sessionId: 'g',
      decisionId: 'stopped:r',
      messageId: 'r',
      stopReason: 'tool_turn_limit',
    });
    await act(async () => el('decision-card-continue-btn').click());
    expect(el('decision-card-continue-btn').hasAttribute('disabled')).toBe(true);
  });
});

describe('DecisionBody', () => {
  const onAnswered = vi.fn();
  const renderBody = (decision: PendingDecision) =>
    themed.render(
      <DecisionBody decision={decision} asker={asker} onOpenDetails={onOpenDetails} onAnswered={onAnswered} />
    );

  it('says a denied approval was denied', async () => {
    await renderBody({
      kind: 'approval',
      sessionId: 'g',
      decisionId: 'approval:ap1',
      approvalId: 'ap1',
      call: call('file_write'),
      collectsSecrets: false,
    });
    await act(async () => el('chat-tool-deny').click());
    expect(chat.respondToApproval).toHaveBeenCalledWith('ap1', expect.objectContaining({ decision: 'deny' }));
    expect(onAnswered).toHaveBeenCalledWith('denied');
  });

  it('says an approved tool was approved', async () => {
    await renderBody({
      kind: 'approval',
      sessionId: 'g',
      decisionId: 'approval:ap1',
      approvalId: 'ap1',
      call: call('file_write'),
      collectsSecrets: false,
    });
    await act(async () => el('chat-tool-approve-once').click());
    expect(onAnswered).toHaveBeenCalledWith('approved');
  });

  it('says a skipped ask-the-user card was answered, not denied', async () => {
    await renderBody({
      kind: 'approval',
      sessionId: 'g',
      decisionId: 'approval:ap1',
      approvalId: 'ap1',
      call: {
        ...call('ask_user'),
        input: {
          questions: [
            {
              question: 'Which branch?',
              options: [
                { label: 'main', description: 'd' },
                { label: 'dev', description: 'd' },
              ],
            },
          ],
        },
      },
      collectsSecrets: false,
    });
    await act(async () => el('chat-question-skip').click());
    expect(chat.respondToApproval).toHaveBeenCalledWith('ap1', { decision: 'deny' });
    expect(onAnswered).toHaveBeenCalledWith('answered');
  });

  it('says a question answered here was answered', async () => {
    await renderBody({
      kind: 'question',
      sessionId: 'g',
      decisionId: 'question:d1',
      decision: {
        id: 'd1',
        askedAt: '2026-10-01',
        question: { header: 'Branch', question: 'Which branch?', options: [{ label: 'main', description: '' }] },
      },
    });
    await act(async () => el('chat-question-skip').click());
    expect(onAnswered).toHaveBeenCalledWith('answered');
  });
});
