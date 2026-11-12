// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { ChatToolCall } from '@shared/chat';
import { expect, it, vi } from 'vitest';
import { ToolCallList } from './ToolCallList';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('answers the project button with the approval ID and project scope', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onRespond = vi.fn();
  const call: ChatToolCall = {
    id: 'call-project',
    name: 'bash_execute',
    input: { command: 'printf ok' },
    status: 'awaiting-approval',
    approvalId: 'approval-project',
    approvalProject: '/project',
    approvalProjectRules: ['Bash(printf:*)'],
  };
  try {
    act(() => root.render(<ToolCallList calls={[call]} onRespond={onRespond} />));
    const button = container.querySelector<HTMLButtonElement>('[data-testid="chat-tool-approve-project"]');
    expect(button).not.toBeNull();
    act(() => button!.click());
    expect(onRespond).toHaveBeenCalledExactlyOnceWith('approval-project', { decision: 'always', project: true });
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
