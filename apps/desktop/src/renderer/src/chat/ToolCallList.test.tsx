import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatToolCall } from '@shared/chat';
import { describe, expect, it } from 'vitest';
import { ToolCallList } from './ToolCallList';

/**
 * Rendered to a string, like ApprovalChoice's tests and for the same reason: this package's
 * vitest runs on `node`, so a click is not answerable here. That the buttons drive a real
 * answer through the gate is covered in ChatService.approval.test.ts.
 *
 * What is asked here is that the transcript still draws the card at all. It is now the only
 * place an approval is answered, so a card that stops rendering is a session blocked forever.
 */
function awaiting(overrides: Partial<ChatToolCall> = {}): ChatToolCall {
  return {
    id: 'call-1',
    name: 'bash',
    input: { command: 'rm -rf build' },
    status: 'awaiting-approval',
    approvalId: 'approval-1',
    approvalDetail: 'rm -rf build',
    ...overrides,
  };
}

function markup(calls: ChatToolCall[]): string {
  return renderToStaticMarkup(<ToolCallList calls={calls} onRespond={() => {}} />);
}

describe('ToolCallList', () => {
  it('draws the approval card for a call waiting in this conversation', () => {
    const html = markup([awaiting()]);
    expect(html).toContain('data-testid="chat-tool-approval"');
    expect(html).toContain('data-testid="chat-tool-approval-detail"');
    expect(html).toContain('rm -rf build');
    expect(html).toContain('data-testid="chat-tool-approve-once"');
    expect(html).toContain('data-testid="chat-tool-approve-always"');
    expect(html).toContain('data-testid="chat-tool-deny"');
  });

  it('withholds "always" on a call that cannot be undone', () => {
    const html = markup([awaiting({ approvalIrreversible: true })]);
    expect(html).toContain('data-irreversible="true"');
    expect(html).not.toContain('data-testid="chat-tool-approve-always"');
  });

  /**
   * The transcript draws only the calls of the conversation it was handed, which is what makes
   * an approval raised elsewhere invisible here. Nothing else in the shell draws one.
   */
  it('draws no approval card when this conversation has nothing waiting', () => {
    const settled = awaiting({ status: 'done', preview: 'ok' });
    delete settled.approvalId;
    delete settled.approvalDetail;
    expect(markup([settled])).not.toContain('data-testid="chat-tool-approval"');
  });
});
