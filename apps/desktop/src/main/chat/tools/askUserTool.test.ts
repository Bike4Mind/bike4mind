import { describe, expect, it } from 'vitest';
import { askUser } from './askUserTool';
import { findTool, toolsForRequest } from './registry';

const context = { roots: [], signal: new AbortController().signal };
const questions = [
  {
    question: 'Which auth method?',
    header: 'Auth',
    options: [
      { label: 'OAuth (Recommended)', description: 'Delegated.' },
      { label: 'API keys', description: 'Static.' },
    ],
  },
];

describe('ask_user', () => {
  it('formats the answer for the model', async () => {
    const result = await askUser.run(
      { questions, outcome: { status: 'answered', answers: [{ selected: ['OAuth (Recommended)'] }] } },
      context
    );
    expect(result).toContain('"Which auth method?" -> "OAuth (Recommended)"');
  });

  it('formats skip and cancel', async () => {
    expect(await askUser.run({ questions, outcome: { status: 'skipped' } }, context)).toMatch(/skipped/);
    expect(await askUser.run({ questions, outcome: { status: 'cancelled' } }, context)).toMatch(/cancelled/);
  });

  it('refuses invalid input with the reason', async () => {
    await expect(askUser.run({ questions: [] }, context)).rejects.toThrow(/non-empty array/);
  });

  it('refuses to run with no one having been asked', async () => {
    await expect(askUser.run({ questions }, context)).rejects.toThrow(/could not be asked/);
  });

  it('declares no approval, so no mode can gate it', () => {
    expect(askUser.approval).toBeUndefined();
    expect(askUser.needsApproval).toBeUndefined();
    expect(askUser.interactive).toBe(true);
    expect(findTool('ask_user')).toBe(askUser);
  });

  it('is offered only when a user is present', () => {
    const names = (ask: boolean) =>
      toolsForRequest({ roots: ['/tmp'], media: false, host: false, ask }).map(tool => tool.toolSchema.name);
    expect(names(true)).toContain('ask_user');
    expect(names(false)).not.toContain('ask_user');
  });
});
