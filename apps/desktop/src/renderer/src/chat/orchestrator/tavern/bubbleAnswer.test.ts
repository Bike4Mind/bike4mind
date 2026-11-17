import { describe, expect, it } from 'vitest';
import type { ChatToolCall } from '@shared/chat';
import type { ChatQuestion } from '@shared/questions';
import { BUBBLE_OPTION_MAX, planForCall, planForQuestion } from './bubbleAnswer';

const call = (extra: Partial<ChatToolCall> = {}): ChatToolCall => ({
  id: 'c1',
  name: 'bash',
  input: { command: 'pnpm test' },
  status: 'awaiting-approval',
  approvalId: 'ap-1',
  ...extra,
});

const question = (labels: string[], extra: Partial<ChatQuestion> = {}): ChatQuestion => ({
  question: 'Which way?',
  header: 'Decision',
  options: labels.map(label => ({ label, description: `Pick ${label}` })),
  ...extra,
});

const decision = { via: 'decision', decisionId: 'd-1' } as const;

describe('planForCall', () => {
  it('offers Approve / Deny for a plain approval, naming the call', () => {
    expect(planForCall(call())).toEqual({ kind: 'approve', approvalId: 'ap-1', summary: 'bash pnpm test' });
  });

  it('sends every approval that needs the full card to Open', () => {
    expect(planForCall(call({ approvalIrreversible: true })).kind).toBe('open');
    expect(planForCall(call({ name: 'request_directory', input: { path: '/x' } })).kind).toBe('open');
    expect(planForCall(call({ approvalChoice: { options: [{ id: 'a', label: 'A', description: '' }] } })).kind).toBe(
      'open'
    );
  });

  it('is Open while nothing is parked yet', () => {
    expect(planForCall(undefined)).toEqual({ kind: 'open' });
  });

  it('answers a one-question ask_user card through the approval it is parked on', () => {
    const plan = planForCall(call({ name: 'ask_user', input: { questions: [question(['Yes (Recommended)', 'No'])] } }));
    expect(plan).toMatchObject({
      kind: 'choose',
      target: { via: 'approval', approvalId: 'ap-1' },
      options: [
        { label: 'Yes (Recommended)', face: 'Yes', recommended: true },
        { label: 'No', face: 'No', recommended: false },
      ],
    });
  });

  it('opens an ask_user card with more than one question', () => {
    const questions = [question(['A', 'B']), { ...question(['C', 'D']), question: 'And?' }];
    expect(planForCall(call({ name: 'ask_user', input: { questions } })).kind).toBe('open');
  });
});

describe('planForQuestion', () => {
  it('draws short single-choice options as buttons', () => {
    expect(planForQuestion(question(['Ship it', 'Wait']), decision)).toMatchObject({
      kind: 'choose',
      prompt: 'Which way?',
      target: decision,
    });
  });

  it('falls back to Open for multi-select, long or destructive options', () => {
    expect(planForQuestion(question(['A', 'B'], { multiSelect: true }), decision).kind).toBe('open');
    expect(planForQuestion(question(['A', 'x'.repeat(BUBBLE_OPTION_MAX + 1)]), decision).kind).toBe('open');
    expect(planForQuestion(question(['Keep the branch', 'Delete the branch']), decision)).toEqual({
      kind: 'open',
      prompt: 'Which way?',
    });
  });
});
