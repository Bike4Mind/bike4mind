import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { UserQuestionPrompt } from './UserQuestionPrompt';

const tick = () => new Promise(resolve => setTimeout(resolve, 60));

const payload = {
  questions: [
    {
      question: 'Delete\rKeep the files?',
      options: [{ label: 'yes‮on', description: 'gone\u009b2K' }],
      multiSelect: false,
    },
  ],
};

describe('UserQuestionPrompt', () => {
  it('escapes control and bidi characters in the question and options', () => {
    const { lastFrame } = render(<UserQuestionPrompt payload={payload} onResponse={() => {}} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Delete\\x0dKeep the files?');
    expect(frame).toContain('yes\\u202eon');
    expect(frame).toContain('gone\\x9b2K');
    expect(frame).not.toContain('\r');
    expect(frame).not.toContain('‮');
  });

  it('answers with the raw option label, not the escaped display form', async () => {
    const onResponse = vi.fn();
    const { stdin } = render(<UserQuestionPrompt payload={payload} onResponse={onResponse} />);
    await tick();
    stdin.write('\r');
    await tick();
    expect(onResponse).toHaveBeenCalledWith({
      answers: [{ question: 'Delete\rKeep the files?', selected: ['yes‮on'] }],
    });
  });
});
