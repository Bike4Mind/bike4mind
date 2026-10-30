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

function bash(overrides: Partial<ChatToolCall> = {}): ChatToolCall {
  return { id: 'call-1', name: 'bash_execute', input: { command: 'pnpm build' }, status: 'running', ...overrides };
}

function withMove(calls: ChatToolCall[]): string {
  return renderToStaticMarkup(
    <ToolCallList calls={calls} onRespond={() => {}} onMove={async () => ({ ok: false, message: 'no' })} />
  );
}

describe('ToolCallList', () => {
  describe('approval attribution', () => {
    const decidedAt = '2026-10-22T00:00:00.000Z';
    const attribution = (html: string) =>
      [...html.matchAll(/data-testid="tool-call-approval-attribution"[^>]*>([^<]*)</g)].map(match => match[1]);

    it.each([
      [{ kind: 'rule', rule: 'Bash(rm:*)' } as const, 'Denied by rule Bash(rm:*)'],
      [{ kind: 'chat-allowance' } as const, 'Denied in this chat'],
      [{ kind: 'mode', mode: 'auto' } as const, 'Denied by the approval mode'],
      [{ kind: 'user', answer: 'deny' } as const, 'Declined by you'],
      [{ kind: 'user', answer: 'redirect', option: 'Start a session' } as const, 'Redirected by you - Start a session'],
      [{ kind: 'system', reason: 'stopped' } as const, 'Not run - reply stopped before approval'],
      [{ kind: 'system', reason: 'app-quit' } as const, 'Not run - app quit before approval'],
      [{ kind: 'system', reason: 'error', detail: 'outside every folder' } as const, 'Blocked - outside every folder'],
    ])('reads %o as "%s"', (decidedBy, text) => {
      const html = markup([
        bash({ status: 'denied', approval: { outcome: 'denied', decidedBy, asked: false, decidedAt } }),
      ]);
      expect(attribution(html)).toEqual([text]);
    });

    it('reads a redirect recorded as done by its outcome, not its status', () => {
      const decidedBy = { kind: 'user', answer: 'redirect', option: 'Start a session' } as const;
      const html = markup([
        bash({ status: 'done', approval: { outcome: 'denied', decidedBy, asked: true, decidedAt } }),
      ]);
      expect(attribution(html)).toEqual(['Redirected by you - Start a session']);
    });

    it.each([
      [{ kind: 'mode', mode: 'auto' } as const],
      [{ kind: 'rule', rule: 'Bash(git commit:*)', source: 'Claude Code settings' } as const],
      [{ kind: 'chat-allowance' } as const],
      [{ kind: 'user', answer: 'once' } as const],
      [{ kind: 'user', answer: 'always', everywhere: true } as const],
    ])('draws nothing for a call %o let through', decidedBy => {
      const html = markup([
        bash({ status: 'done', approval: { outcome: 'allowed', decidedBy, asked: false, decidedAt } }),
      ]);
      expect(html).not.toContain('tool-call-approval-attribution');
      expect(html).not.toContain('Claude Code settings');
    });

    it('says it once for a group stopped the same way, and nothing for an ungated call', () => {
      const stopped = {
        outcome: 'denied',
        decidedBy: { kind: 'system', reason: 'stopped' },
        asked: true,
        decidedAt,
      } as const;
      const html = markup([
        bash({ id: 'a', status: 'denied', approval: stopped }),
        bash({ id: 'b', status: 'denied', approval: stopped }),
        bash({ id: 'c', status: 'done' }),
      ]);
      expect(attribution(html)).toEqual(['Not run - reply stopped before approval']);
      expect(attribution(markup([bash({ status: 'done' })]))).toEqual([]);
    });

    it('keeps only what did not run in a group that mixes it with allowed calls', () => {
      const allowed = (decidedBy: NonNullable<ChatToolCall['approval']>['decidedBy']) =>
        ({ outcome: 'allowed', decidedBy, asked: false, decidedAt }) as const;
      const html = markup([
        bash({ id: 'a', status: 'done', approval: allowed({ kind: 'mode', mode: 'auto' }) }),
        bash({ id: 'b', status: 'done', approval: allowed({ kind: 'user', answer: 'once' }) }),
        bash({ id: 'c', status: 'done', approval: allowed({ kind: 'chat-allowance' }) }),
        bash({
          id: 'd',
          status: 'denied',
          approval: { outcome: 'denied', decidedBy: { kind: 'user', answer: 'deny' }, asked: true, decidedAt },
        }),
      ]);
      expect(attribution(html)).toEqual(['Declined by you']);
    });
  });

  it('shows a failed permission save outside the collapsed tool result', () => {
    const html = markup([
      bash({
        status: 'done',
        notice: { kind: 'permissions-save-failed', text: 'Rules could not be saved: disk full.' },
      }),
    ]);
    expect(html).toContain('data-testid="chat-tool-permissions-notice"');
    expect(html).toContain('Permission rule was not saved');
    expect(html).toContain('disk full');
  });

  it('draws the approval card for a call waiting in this conversation', () => {
    const html = markup([awaiting()]);
    expect(html).toContain('data-testid="chat-tool-approval"');
    expect(html).toContain('data-testid="chat-tool-approval-detail"');
    expect(html).toContain('rm -rf build');
    expect(html).toContain('data-testid="chat-tool-approve-once"');
    expect(html).toContain('data-testid="chat-tool-approve-always"');
    expect(html).toContain('data-testid="chat-tool-deny"');
  });

  /**
   * The button says the action and nothing else. It used to carry the whole granted scope, so a
   * command touching two directories gave the broadest choice on the card the widest button.
   */
  it('keeps the allow-in-this-chat button to a fixed label and puts the scope beside it', () => {
    const html = markup([
      awaiting({
        approvalAlways: '`ls *`, `head *`, ~/Javascript/*, ./*',
        approvalAlwaysFull: '`ls *`, `head *`, /Users/jude/Javascript/*, /Users/jude/Javascript/bike4mind/*',
      }),
    ]);
    const button = html.slice(html.indexOf('data-testid="chat-tool-approve-always"'));
    expect(button.slice(0, button.indexOf('</button>'))).toContain('Allow in this chat');
    expect(button.slice(0, button.indexOf('</button>'))).not.toContain('~/Javascript');

    expect(html).toContain('data-testid="chat-tool-approval-scope"');
    expect(html).toContain('~/Javascript/*');
    expect(html).toContain('for the rest of this conversation');
    // The abbreviated paths are not the only account of what is granted.
    expect(html).toContain('/Users/jude/Javascript/bike4mind/*');
  });

  /** The fallback: a tool whose "always" covers no patterns and no directories. */
  it('still offers always-allow when there is no scope to name', () => {
    const html = markup([awaiting()]);
    expect(html).toContain('data-testid="chat-tool-approve-always"');
    expect(html).toContain('data-testid="chat-tool-approval-scope"');
    expect(html).toContain('applies for the rest of this conversation');
  });

  it('offers the saving "Always allow" only when main derived a rule, and names the rule', () => {
    expect(markup([awaiting()])).not.toContain('data-testid="chat-tool-approve-everywhere"');

    const html = markup([awaiting({ approvalRules: ['Bash(gh pr create:*)'] })]);
    const button = html.slice(html.indexOf('data-testid="chat-tool-approve-everywhere"'));
    expect(button.slice(0, button.indexOf('</button>'))).toContain('Always allow');
    expect(html).toContain('data-testid="chat-tool-approval-rules"');
    expect(html).toContain('saves Bash(gh pr create:*) to Settings &gt; Permissions, so no session asks again');
  });

  it('says a bare rule covers every site or every call', () => {
    const fetch = markup([awaiting({ name: 'web_fetch', approvalAlways: 'every site', approvalRules: ['WebFetch'] })]);
    expect(fetch).toContain('&quot;Allow in this chat&quot; covers every site for the rest of this conversation');
    expect(fetch).toContain('saves WebFetch (every site) to Settings');
    expect(markup([awaiting({ name: 'session_send', approvalRules: ['session_send'] })])).toContain(
      'saves session_send (every call) to Settings'
    );
  });

  it('never offers the saving "Always allow" on a call that cannot be undone', () => {
    const html = markup([awaiting({ approvalIrreversible: true, approvalRules: ['session_delete'] })]);
    expect(html).not.toContain('data-testid="chat-tool-approve-everywhere"');
  });

  it('withholds "always" on a call that cannot be undone', () => {
    const html = markup([awaiting({ approvalIrreversible: true })]);
    expect(html).toContain('data-irreversible="true"');
    expect(html).not.toContain('data-testid="chat-tool-approve-always"');
    // No standing grant to describe, so no line promising one.
    expect(html).not.toContain('data-testid="chat-tool-approval-scope"');
    expect(html).toContain('Delete it');
    expect(html).toContain('Keep it');
  });

  /** The write variants keep their own wording either side of the restructured button row. */
  it('keeps the diff wording for one file and for a patch across several', () => {
    const diff = (path: string) => ({ path, operation: 'edit' as const, added: 1, removed: 0, lines: [] });

    const one = markup([awaiting({ approvalDiff: diff('/a/one.ts') })]);
    expect(one).toContain('Apply this edit?');
    expect(one).toContain('Apply this change');
    // Static markup escapes the apostrophe.
    expect(one).toContain('Don&#x27;t change it');

    const many = markup([awaiting({ approvalDiffs: [diff('/a/one.ts'), diff('/a/two.ts')] })]);
    expect(many).toContain('Apply this patch to 2 files?');
    expect(many).toContain('data-testid="chat-tool-approve-always"');
  });

  it('offers a running command a way out of the foreground', () => {
    const html = withMove([bash()]);
    expect(html).toContain('data-testid="component-action-element"');
    expect(html).toContain('Move to background');
  });

  /** The choice only exists while the app is still waiting: after that there is nothing to move. */
  it('draws no move control on a call that has already settled', () => {
    expect(withMove([bash({ status: 'done', preview: 'built' })])).not.toContain(
      'data-testid="component-action-element"'
    );
    expect(withMove([bash({ name: 'file_read', input: { path: 'a.ts' } })])).not.toContain(
      'data-testid="component-action-element"'
    );
  });

  it('says a moved command was moved rather than that it finished', () => {
    const html = withMove([bash({ status: 'moved', preview: 'moved to the background' })]);
    expect(html).toContain('Moved pnpm build to the background');
    expect(html).toContain('data-status="moved"');
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

describe('ToolCallList ask_user', () => {
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
  const asked = (overrides: Partial<ChatToolCall> = {}): ChatToolCall => ({
    id: 'q1',
    name: 'ask_user',
    input: { questions },
    status: 'awaiting-approval',
    approvalId: 'approval-1',
    ...overrides,
  });

  it('draws the question card, not an approval, while waiting', () => {
    const html = markup([asked()]);
    expect(html).toContain('data-testid="chat-question-card"');
    expect(html).not.toContain('chat-tool-approval');
  });

  it('labels the settled row with the question and the answer', () => {
    const html = markup([
      asked({
        status: 'done',
        approvalId: undefined,
        input: { questions, outcome: { status: 'answered', answers: [{ selected: ['OAuth (Recommended)'] }] } },
      }),
    ]);
    expect(html).toContain('Asked: Which auth method? - OAuth (Recommended)');
  });

  // The answers themselves are drawn once the row is opened; see ToolCallList.open.test.tsx.
  it('keeps the settled answers behind the closed row after a reload', () => {
    const html = markup([
      asked({
        status: 'done',
        approvalId: undefined,
        input: { questions, outcome: { status: 'answered', answers: [{ selected: [], other: 'mTLS' }] } },
      }),
    ]);
    expect(html).toContain('data-testid="chat-tool-row"');
    expect(html).not.toContain('data-testid="chat-question-answer-0"');
  });

  it('says so on a skipped row', () => {
    const html = markup([
      asked({ status: 'done', approvalId: undefined, input: { questions, outcome: { status: 'skipped' } } }),
    ]);
    expect(html).toContain('Asked: Which auth method? - skipped');
  });
});
