// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatToolCall } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolCallList } from './ToolCallList';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function patch(id: string): ChatToolCall {
  return {
    id,
    name: 'apply_patch',
    input: { path: `/project/src/${id}.ts` },
    status: 'done',
    preview: 'x'.repeat(5000),
    diff: {
      path: `/project/src/${id}.ts`,
      operation: 'edit',
      added: 1,
      removed: 1,
      lines: [
        { kind: 'remove', text: 'const a = 1;', oldLine: 1 },
        { kind: 'add', text: 'const a = 2;', newLine: 1 },
      ],
    },
  };
}

/**
 * A closed row is one line of the transcript, and what is behind it - output, diff, highlighting
 * - is what made a long conversation slow to open. Those must not exist until it is opened.
 */
describe('a tool row behind its disclosure', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const count = (testId: string) => container.querySelectorAll(`[data-testid="${testId}"]`).length;

  const open = (element: Element) =>
    act(() => {
      (element as HTMLDetailsElement).open = true;
      element.dispatchEvent(new Event('toggle'));
    });

  it('mounts nothing of a single call until it is opened', () => {
    act(() => root.render(<ToolCallList calls={[patch('a')]} onRespond={() => undefined} />));
    expect(count('chat-tool-row')).toBe(1);
    expect(count('chat-tool-detail')).toBe(0);
    expect(count('chat-tool-diff')).toBe(0);

    open(container.querySelector('[data-testid="chat-tool-row"]') as Element);

    expect(count('chat-tool-detail')).toBe(1);
    expect(count('chat-tool-diff')).toBe(1);
  });

  it("shows a settled question's answers from the stored call once opened", () => {
    const asked: ChatToolCall = {
      id: 'q1',
      name: 'ask_user',
      status: 'done',
      input: {
        questions: [
          {
            question: 'Which auth method?',
            header: 'Auth',
            options: [
              { label: 'OAuth', description: 'Delegated.' },
              { label: 'API keys', description: 'Static.' },
            ],
          },
        ],
        outcome: { status: 'answered', answers: [{ selected: [], other: 'mTLS' }] },
      },
    };
    act(() => root.render(<ToolCallList calls={[asked]} onRespond={() => undefined} />));

    open(container.querySelector('[data-testid="chat-tool-row"]') as Element);

    expect(count('chat-question-answer-0')).toBe(1);
    expect(container.textContent).toContain('mTLS');
  });

  it('mounts a group entry by entry, as each is opened', () => {
    act(() => root.render(<ToolCallList calls={[patch('a'), patch('b')]} onRespond={() => undefined} />));
    expect(count('chat-tool-entry')).toBe(0);

    open(container.querySelector('[data-testid="chat-tool-row"]') as Element);
    expect(count('chat-tool-entry')).toBe(2);
    expect(count('chat-tool-detail')).toBe(0);

    open(container.querySelectorAll('[data-testid="chat-tool-entry"]')[1]);
    expect(count('chat-tool-detail')).toBe(1);
    expect(count('chat-tool-diff')).toBe(1);
  });
});
