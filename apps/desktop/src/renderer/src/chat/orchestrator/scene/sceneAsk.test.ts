import { describe, expect, it } from 'vitest';
import type { ChatToolCall } from '@shared/chat';
import type { PendingDecision } from '@shared/pendingDecisions';
import { ASK_STATE_LABEL, sceneAskOf } from './sceneAsk';

const call = (name: string, input: Record<string, unknown>): ChatToolCall => ({
  id: 'c1',
  name,
  input,
  status: 'awaiting-approval',
  approvalId: 'ap1',
});

const approval = (toolCall: ChatToolCall, collectsSecrets = false): PendingDecision => ({
  kind: 'approval',
  sessionId: 's',
  decisionId: 'approval:ap1',
  approvalId: 'ap1',
  call: toolCall,
  collectsSecrets,
});

const askUser = (questions: unknown) => approval(call('ask_user', { questions }));

describe('sceneAskOf', () => {
  it('summarizes a tool approval as the tool and its target', () => {
    expect(sceneAskOf(approval(call('bash_execute', { command: 'ls -la' })))).toEqual({
      what: 'bash_execute ls -la',
      options: [],
    });
  });

  it('names only the tool when the card collects secrets', () => {
    const ask = sceneAskOf(approval(call('mcp_setup', { command: 'API_KEY=hunter2 run' }), true));
    expect(ask).toEqual({ what: 'mcp_setup', options: [] });
  });

  it('cuts a long summary to 60 characters', () => {
    const { what } = sceneAskOf(approval(call('bash_execute', { command: 'x'.repeat(200) })));
    expect(what).toHaveLength(60);
    expect(what.endsWith('\u2026')).toBe(true);
  });

  it('shows an ask_user question with its option faces, recommended suffix removed', () => {
    const ask = sceneAskOf(
      askUser([
        {
          question: 'Which branch?',
          options: [
            { label: 'main (Recommended)', description: 'd' },
            { label: 'dev', description: 'd' },
          ],
        },
      ])
    );
    expect(ask).toEqual({ what: 'Which branch?', options: ['main', 'dev'] });
  });

  it('shows at most four options on a task question, each cut to 18 characters', () => {
    const options = ['a', 'b', 'c', 'd', 'e'].map(letter => ({ label: letter.repeat(30), description: 'd' }));
    const ask = sceneAskOf({
      kind: 'question',
      sessionId: 's',
      decisionId: 'question:d1',
      decision: { id: 'd1', askedAt: '2026-10-01', question: { header: 'Pick', question: 'Pick one', options } },
    });
    expect(ask.options).toHaveLength(4);
    expect(ask.options[0]).toHaveLength(18);
  });

  it('falls back to the tool summary when the ask_user questions do not parse', () => {
    const ask = sceneAskOf(askUser('not an array'));
    expect(ask.options).toEqual([]);
    expect(ask.what.startsWith('ask_user')).toBe(true);
  });

  it('shows a task question and its options', () => {
    const ask = sceneAskOf({
      kind: 'question',
      sessionId: 's',
      decisionId: 'question:d1',
      decision: {
        id: 'd1',
        askedAt: '2026-10-01',
        question: { header: 'Branch', question: 'Which branch?', options: [{ label: 'main', description: 'd' }] },
      },
    });
    expect(ask).toEqual({ what: 'Which branch?', options: ['main'] });
  });

  it('describes a stopped turn and a failed turn', () => {
    expect(sceneAskOf({ kind: 'stopped', sessionId: 's', decisionId: 'stopped:s' } as PendingDecision).what).toBe(
      'Paused before finishing'
    );
    const failed = sceneAskOf({
      kind: 'error',
      sessionId: 's',
      decisionId: 'error:s',
      error: 'boom',
    } as PendingDecision);
    expect(failed.what).toBe('Failed: boom');
  });

  it('labels every state', () => {
    expect(ASK_STATE_LABEL.elsewhere).toBe('Answered elsewhere');
  });
});
