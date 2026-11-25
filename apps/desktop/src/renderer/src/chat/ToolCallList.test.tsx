// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatToolCall, ChatImageActionResult, ChatMedia, ChatDiff, ChatToolStatus } from '@shared/chat';
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { ToolCallList } from './ToolCallList';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { ImageMenuProvider } from './ImageContextMenu';
import { diffTotals, groupToolCalls, shortenArgument, toolRowLabel } from './toolRows';
import { MODEL_REQUEST_REFUSED } from '@shared/orchestration';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The static-markup tests ask that the transcript still draws the card at all. It is the only
 * place an approval is answered, so a card that stops rendering is a session blocked forever.
 * That the buttons drive a real answer through the gate is covered in ChatService.approval.test.ts.
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

    // describeApproval returns null for every allowed outcome before it looks at who decided.
    it('draws nothing for a call let through', () => {
      const decidedBy = { kind: 'rule', rule: 'Bash(git commit:*)', source: 'Claude Code settings' } as const;
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
    // The fallback: a tool whose "always" covers no patterns and no directories still names its reach.
    expect(html).toContain('data-testid="chat-tool-approval-scope"');
    expect(html).toContain('applies for the rest of this conversation');
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

  it('offers the saving "Always allow" only when main derived a rule, and names the rule', () => {
    expect(markup([awaiting()])).not.toContain('data-testid="chat-tool-approve-everywhere"');

    const html = markup([awaiting({ approvalRules: ['Bash(gh pr create:*)'] })]);
    const button = html.slice(html.indexOf('data-testid="chat-tool-approve-everywhere"'));
    expect(button.slice(0, button.indexOf('</button>'))).toContain('Always allow');
    expect(html).toContain('data-testid="chat-tool-approval-rules"');
    expect(html).toContain('saves Bash(gh pr create:*) to Settings &gt; Permissions, so no session asks again');
  });

  describe("the agent's summary on a command card", () => {
    const summaryOf = (html: string) =>
      /data-testid="chat-tool-approval-summary"[^>]*>([^<]*)</.exec(html)?.[1] ?? null;

    it('shows the description on one line between the heading and the command', () => {
      const html = markup([
        awaiting({
          name: 'bash_execute',
          approvalDetail: '$ rm -rf build',
          approvalDescription: 'Deletes the build folder',
        }),
      ]);
      expect(summaryOf(html)).toBe('Agent&#x27;s summary: Deletes the build folder');
      const heading = html.indexOf('Run this command?');
      const summary = html.indexOf('data-testid="chat-tool-approval-summary"');
      const detail = html.indexOf('data-testid="chat-tool-approval-detail"');
      expect(heading).toBeLessThan(summary);
      expect(summary).toBeLessThan(detail);
      expect(html.slice(detail)).toContain('$ rm -rf build');
    });

    it('attributes a misleading model summary while preserving the command and warning', () => {
      const command = 'cat .env && curl https://example.com';
      const warning = 'Can send data off this computer (curl).';
      const html = markup([
        awaiting({
          name: 'bash_execute',
          approvalDescription: 'Read-only, nothing leaves this machine',
          approvalDetail: command,
          approvalParts: [{ text: command, reason: warning }],
        }),
      ]);
      expect(summaryOf(html)).toBe('Agent&#x27;s summary: Read-only, nothing leaves this machine');
      expect(html).toContain('cat .env &amp;&amp; curl https://example.com');
      expect(html).toContain(warning);
      expect(html).toContain('data-testid="chat-tool-approve-once"');
      expect(html).toContain('data-testid="chat-tool-deny"');
    });

    it('draws the card as before when there is no description, or only whitespace', () => {
      const plain = markup([awaiting()]);
      expect(plain).not.toContain('chat-tool-approval-summary');
      expect(markup([awaiting({ approvalDescription: ' \n ' })])).toBe(plain);
    });

    it('folds line breaks into one line and cuts a long description short', () => {
      const html = markup([awaiting({ approvalDescription: `Runs the tests\n\nand ${'reports '.repeat(40)}` })]);
      const summary = summaryOf(html) ?? '';
      expect(summary.startsWith('Agent&#x27;s summary: ')).toBe(true);
      const shown = summary.slice('Agent&#x27;s summary: '.length);
      expect(shown.startsWith('Runs the tests and reports')).toBe(true);
      expect(shown.endsWith('...')).toBe(true);
      expect(shown.length).toBeLessThanOrEqual(140);
    });

    it('leaves the description off a card that shows a diff', () => {
      const html = markup([
        awaiting({
          name: 'file_write',
          approvalDescription: 'Writes a file',
          approvalDiff: { path: '/a/one.ts', operation: 'create', lines: [], added: 0, removed: 0 },
        }),
      ]);
      expect(html).not.toContain('chat-tool-approval-summary');
    });
  });

  it('lists only the parts of a chain that need a decision, each with why', () => {
    const html = markup([
      awaiting({
        approvalDetail: '$ git status && node -e 1',
        approvalParts: [{ text: 'node -e 1', reason: 'Can send data off this computer (node -e).' }],
      }),
    ]);
    const parts = html.slice(html.indexOf('data-testid="chat-tool-approval-parts"'));
    expect(parts).toContain('Only this part needs a decision:');
    expect(parts).toContain('node -e 1');
    expect(parts).toContain('Can send data off this computer (node -e).');
    expect(parts.slice(0, parts.indexOf('chat-tool-approve-once'))).not.toContain('git status');
    expect(markup([awaiting()])).not.toContain('data-testid="chat-tool-approval-parts"');
  });

  it('offers "Allow in this project" only when main derived prefix rules for it, and names them', () => {
    expect(markup([awaiting()])).not.toContain('data-testid="chat-tool-approve-project"');

    const html = markup([
      awaiting({ approvalProjectRules: ['Bash(git diff:*)'], approvalProject: '/Users/me/code/app' }),
    ]);
    const button = html.slice(html.indexOf('data-testid="chat-tool-approve-project"'));
    expect(button.slice(0, button.indexOf('</button>'))).toContain('Allow in this project');
    expect(html).toContain('saves Bash(git diff:*) for every session in app.');
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

  it('asks once for a whole batch of deletes, naming how many', () => {
    const html = markup([
      awaiting({ name: 'session_delete', input: { session_ids: ['a', 'b', 'c'] }, approvalIrreversible: true }),
    ]);
    expect(html).toContain('Delete these 3 conversations for good?');
    expect(html).toContain('Delete them');
    expect(html).toContain('Keep them');
    const single = markup([
      awaiting({ name: 'session_delete', input: { session_ids: ['a'] }, approvalIrreversible: true }),
    ]);
    expect(single).toContain('Delete this conversation for good?');
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

  it('offers only allow-once and deny on a card main will honour once', () => {
    const html = markup([
      awaiting({ approvalOnceOnly: true, approvalRules: ['Bash(./run.sh)'], approvalAlways: 'run.sh' }),
    ]);
    expect(html).toContain('data-testid="chat-tool-approve-once"');
    expect(html).toContain('data-testid="chat-tool-deny"');
    expect(html).not.toContain('data-testid="chat-tool-approve-always"');
    expect(html).not.toContain('data-testid="chat-tool-approve-everywhere"');
    expect(html).not.toContain('data-testid="chat-tool-approval-scope"');
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

  // The answers themselves are drawn once the row is opened; see 'opening a row' below.
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

describe('opening a row', () => {
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

    it("shows the agent's summary of a settled command once opened, read from the call's input", () => {
      const shell = (id: string, input: ChatToolCall['input'], name = 'bash_execute'): ChatToolCall => ({
        id,
        name,
        input,
        status: 'done',
        preview: 'ok',
      });
      const summaries = (calls: ChatToolCall[]) => {
        act(() => root.render(<ToolCallList calls={calls} onRespond={() => undefined} />));
        open(container.querySelector('[data-testid="chat-tool-row"]') as Element);
        return [...container.querySelectorAll('[data-testid="chat-tool-detail-summary"]')].map(el => el.textContent);
      };

      expect(summaries([shell('a', { command: 'pnpm build', description: 'Builds the app' })])).toEqual([
        "Agent's summary: Builds the app",
      ]);
      expect(container.querySelector('[data-testid="chat-tool-detail-input"]')?.textContent).toBe('pnpm build');
      expect(summaries([shell('b', { command: 'pnpm build' })])).toEqual([]);
      expect(summaries([shell('c', { path: 'a.ts', description: 'Reads a file' }, 'file_read')])).toEqual([]);
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
});

describe('copying and clipping', () => {
  /** jsdom lays nothing out, so a block's height here is its text's length against a fixed clip. */
  const CLIP_HEIGHT = 200;
  const writeText = vi.fn<(text: string) => Promise<void>>();

  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    writeText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.textContent?.length ?? 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return Math.min(this.textContent?.length ?? 0, CLIP_HEIGHT);
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    // Back to jsdom's own prototype getters.
    delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
    delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
  });

  function bash(overrides: Partial<ChatToolCall> = {}): ChatToolCall {
    return { id: 'call-1', name: 'bash_execute', input: { command: 'pnpm build' }, status: 'done', ...overrides };
  }

  const find = (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

  function renderOpened(call: ChatToolCall): void {
    act(() => root.render(<ToolCallList calls={[call]} onRespond={() => undefined} />));
    const row = container.querySelector('[data-testid="chat-tool-row"]') as HTMLDetailsElement;
    act(() => {
      row.open = true;
      row.dispatchEvent(new Event('toggle'));
    });
  }

  async function press(testId: string): Promise<void> {
    await act(async () => find(testId)!.click());
  }

  describe('tool call copy buttons', () => {
    it("copies a shell call's command, named as a command", async () => {
      renderOpened(bash({ preview: 'done' }));
      expect(find('chat-tool-detail-input-copy-btn')?.getAttribute('aria-label')).toBe('Copy command');

      await press('chat-tool-detail-input-copy-btn');

      expect(writeText).toHaveBeenCalledWith(find('chat-tool-detail-input')!.textContent);
      expect(find('chat-tool-detail-input-copy-btn')?.getAttribute('aria-label')).toBe('Copied');
    });

    it("copies a call's output exactly", async () => {
      const preview = 'line one\n  line two\n';
      renderOpened(bash({ preview }));

      await press('chat-tool-detail-output-copy-btn');

      expect(writeText).toHaveBeenCalledWith(preview);
    });

    it('copies the error of a failed call, named as an error', async () => {
      renderOpened(bash({ status: 'error', error: 'exit 1: boom' }));
      expect(find('chat-tool-detail-output-copy-btn')?.getAttribute('aria-label')).toBe('Copy error');

      await press('chat-tool-detail-output-copy-btn');

      expect(writeText).toHaveBeenCalledWith('exit 1: boom');
    });

    it('offers no output copy while a call has produced nothing yet', () => {
      renderOpened(bash({ status: 'running' }));
      expect(find('chat-tool-detail-result')?.textContent).toBe('Running...');
      expect(find('chat-tool-detail-output-copy-btn')).toBeNull();
    });

    it("copies an approval's bare command, not the display text the card shows", async () => {
      // The shape main builds for a shell approval: the prompt, its folder, then any gate reasons.
      const approvalDetail = '$ rm -rf dist\n\nin /repo\n\nOutside the project folder.';
      act(() =>
        root.render(
          <ToolCallList
            calls={[
              bash({
                input: { command: 'rm -rf dist' },
                status: 'awaiting-approval',
                approvalId: 'a1',
                approvalDetail,
              }),
            ]}
            onRespond={() => undefined}
          />
        )
      );
      expect(find('chat-tool-approval-detail')?.textContent).toBe(approvalDetail);
      expect(find('chat-tool-approval-copy-btn')?.getAttribute('aria-label')).toBe('Copy command');

      await press('chat-tool-approval-copy-btn');

      expect(writeText).toHaveBeenCalledWith('rm -rf dist');
    });
  });

  describe('clipped tool output', () => {
    it('offers no Expand when the output fits its clip', () => {
      renderOpened(bash({ preview: 'short' }));
      expect(find('chat-tool-detail-output-clip')).not.toBeNull();
      expect(find('chat-tool-detail-output-clip-toggle')).toBeNull();
    });

    it('expands long output to its full height and collapses it back', () => {
      renderOpened(bash({ preview: 'x'.repeat(5000) }));
      const clip = () => find('chat-tool-detail-output-clip')!;
      const toggle = () => find('chat-tool-detail-output-clip-toggle')!;

      expect(toggle().tagName).toBe('BUTTON');
      expect(toggle().textContent).toBe('Expand');
      expect(toggle().getAttribute('aria-expanded')).toBe('false');
      expect(toggle().getAttribute('aria-controls')).toBe(clip().id);
      expect(clip().dataset.expanded).toBe('false');

      act(() => toggle().click());
      expect(clip().dataset.expanded).toBe('true');
      expect(toggle().textContent).toBe('Collapse');
      expect(toggle().getAttribute('aria-expanded')).toBe('true');

      act(() => toggle().click());
      expect(clip().dataset.expanded).toBe('false');
      expect(toggle().textContent).toBe('Expand');
    });

    it('offers Expand once streaming output grows past the clip', () => {
      renderOpened(bash({ status: 'running', progress: 'starting' }));
      expect(find('chat-tool-detail-output-clip-toggle')).toBeNull();

      act(() =>
        root.render(
          <ToolCallList calls={[bash({ status: 'running', progress: 'y'.repeat(800) })]} onRespond={() => undefined} />
        )
      );

      expect(find('chat-tool-detail-output-clip-toggle')).not.toBeNull();
    });

    it('clips a long approval command the same way', () => {
      act(() =>
        root.render(
          <ToolCallList
            calls={[bash({ status: 'awaiting-approval', approvalId: 'a1', approvalDetail: 'z'.repeat(900) })]}
            onRespond={() => undefined}
          />
        )
      );
      expect(find('chat-tool-approval-detail-clip-toggle')?.textContent).toBe('Expand');
    });
  });
});

describe('tool media', () => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;

  const MEDIA: ChatMedia = {
    kind: 'image',
    url: 'b4m-media://media/s1/00000000-0000-4000-8000-000000000000.png',
    mimeType: 'image/png',
    byteLength: 10,
    caption: 'https://example.com',
  };

  /** A settled call that produced one image, whatever tool it was. */
  function produced(name: string): ChatToolCall {
    return { id: 'call-1', name, input: {}, status: 'done', media: [MEDIA] };
  }

  const imageAction = vi.fn(async (..._args: unknown[]): Promise<ChatImageActionResult> => ({
    ok: true,
    done: false,
  }));

  let root: Root;
  let container: HTMLDivElement;

  async function render(node: ReactNode) {
    await act(async () => root.render(<CssVarsProvider>{node}</CssVarsProvider>));
  }

  const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

  /** Right-click the image, then choose Save from the menu. */
  async function saveImage() {
    const image = byTestId('chat-media-view-btn');
    if (!image) throw new Error('the tool media did not render');
    await act(async () => {
      image.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 }));
    });
    const save = byTestId('image-menu-save-btn');
    if (!save) throw new Error('the save item is missing');
    await act(async () => save.click());
  }

  beforeEach(() => {
    imageAction.mockClear();
    vi.stubGlobal('b4m', { chat: { imageAction } });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  describe('naming a saved tool image', () => {
    it('names a browser screenshot after what took it', async () => {
      await render(
        <ImageMenuProvider onAttach={async () => {}}>
          <ToolCallList calls={[produced('browser_screenshot')]} onRespond={() => {}} />
        </ImageMenuProvider>
      );

      await saveImage();

      expect(imageAction).toHaveBeenCalledWith({ source: 'media', url: MEDIA.url, nameHint: 'screenshot' }, 'save');
    });

    it('names any other tool image plainly', async () => {
      await render(
        <ImageMenuProvider onAttach={async () => {}}>
          <ToolCallList calls={[produced('generate_image')]} onRespond={() => {}} />
        </ImageMenuProvider>
      );

      await saveImage();

      expect(imageAction).toHaveBeenCalledWith({ source: 'media', url: MEDIA.url, nameHint: 'image' }, 'save');
    });
  });

  describe('an image file_read read', () => {
    const read = (id: string, media: ChatMedia): ChatToolCall => ({
      id,
      name: 'file_read',
      input: { path: '/tmp/shot.png' },
      status: 'done',
      preview: '/tmp/shot.png is a PNG image (149.1 KB), 2560x1664.',
      media: [media],
    });
    const SIZED: ChatMedia = { ...MEDIA, width: 1568, height: 1019 };

    // jsdom does not toggle <details> on a summary click, so open it the way the browser would.
    async function openDetails(element: Element | undefined) {
      if (!element) throw new Error('nothing to open');
      await act(async () => {
        (element as HTMLDetailsElement).open = true;
        element.dispatchEvent(new Event('toggle'));
      });
    }
    const openRow = () => openDetails(document.querySelector('[data-testid="chat-tool-row"]') ?? undefined);

    it('draws the image in the row body once the row is open, not under the closed row', async () => {
      await render(<ToolCallList calls={[read('call-1', SIZED)]} onRespond={() => {}} />);
      expect(byTestId('chat-media-thumbnail')).toBeNull();
      expect(byTestId('chat-media-image')).toBeNull();

      await openRow();

      const detail = byTestId('chat-tool-detail');
      const thumbnail = detail?.querySelector<HTMLImageElement>('[data-testid="chat-media-thumbnail"] img');
      expect(thumbnail?.getAttribute('src')).toBe(MEDIA.url);
      expect(thumbnail?.getAttribute('loading')).toBe('lazy');
      expect(byTestId('chat-tool-detail-result')?.textContent).toContain('is a PNG image');
    });

    it('opens the image full size on click', async () => {
      await render(<ToolCallList calls={[read('call-1', SIZED)]} onRespond={() => {}} />);
      await openRow();
      await act(async () => byTestId('chat-media-view-btn')?.click());
      expect(document.querySelector(`img[src="${MEDIA.url}"][alt="${MEDIA.caption}"]`)).not.toBeNull();
      expect(document.querySelectorAll(`img[src="${MEDIA.url}"]`).length).toBeGreaterThan(1);
    });

    it('shows each read in a group of reads under its own entry', async () => {
      const other: ChatMedia = { ...MEDIA, url: 'b4m-media://media/s1/11111111-1111-4111-8111-111111111111.png' };
      await render(<ToolCallList calls={[read('call-1', MEDIA), read('call-2', other)]} onRespond={() => {}} />);
      await openRow();
      expect(byTestId('chat-media-thumbnail')).toBeNull();

      await openDetails(document.querySelectorAll('[data-testid="chat-tool-entry"]')[1]);
      const shown = [...document.querySelectorAll<HTMLImageElement>('[data-testid="chat-media-thumbnail"] img')];
      expect(shown.map(image => image.getAttribute('src'))).toEqual([other.url]);
    });
  });
});

describe('the project approval button', () => {
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
});

describe('toolRows', () => {
  function call(
    id: string,
    name: string,
    input: Record<string, unknown> = {},
    status: ChatToolStatus = 'done'
  ): ChatToolCall {
    return { id, name, input, status };
  }

  /** A write that landed. Only the counts matter here; DiffView's tests cover the lines. */
  function wrote(id: string, path: string, added: number, removed: number): ChatToolCall {
    const diff: ChatDiff = { path, operation: 'edit', added, removed, lines: [] };
    return { ...call(id, 'file_edit', { path }), diff };
  }

  describe('toolRowLabel', () => {
    it('names what the call acted on', () => {
      expect(toolRowLabel(call('1', 'file_read', { path: 'src/app.ts' }))).toBe('Read src/app.ts');
      expect(toolRowLabel(call('2', 'bash_execute', { command: 'pnpm lint' }))).toBe('Ran pnpm lint');
      expect(toolRowLabel(call('3', 'file_edit', { path: 'src/app.ts' }))).toBe('Edited src/app.ts');
    });

    it('names what a search looked for, not the folder it looked in', () => {
      const search = call('1', 'grep_search', { path: '/tmp/project', pattern: 'handleClick' });
      expect(toolRowLabel(search)).toBe('Searched for handleClick');
    });

    it('falls back to the bare phrase when there is nothing to name', () => {
      expect(toolRowLabel(call('1', 'file_read'))).toBe('Read a file');
      expect(toolRowLabel(call('2', 'bash_list'))).toBe('Listed background processes');
    });

    it('labels a tool named like an Object member as an unknown tool', () => {
      for (const name of ['constructor', 'toString']) {
        expect(toolRowLabel(call('1', name, { path: 'a.ts' })), name).toBe(
          toolRowLabel(call('1', 'no_such_tool', { path: 'a.ts' })).replace('no_such_tool', name)
        );
      }
    });

    it('leaves a generation prompt out of the label rather than reciting it', () => {
      expect(toolRowLabel(call('1', 'generate_image', { prompt: 'a red bicycle at dusk' }))).toBe('Generated an image');
    });

    // session_send is the case this exists for: its only nameable argument is a uuid, so the row
    // would name nothing a reader recognises without the tool supplying the target's title.
    it('prefers a label the tool supplied over anything its arguments could say', () => {
      const sent = call('1', 'session_send', { session_id: 'b4e1', message: 'move MCP under Customize' });
      expect(toolRowLabel({ ...sent, label: 'Messaged @Customize: move MCP under Customize' })).toBe(
        'Messaged @Customize: move MCP under Customize'
      );
    });

    it('does not let a supplied label claim a call that failed or was refused', () => {
      const sent = call('1', 'session_send', { session_id: 'b4e1', message: 'hello' }, 'denied');
      expect(toolRowLabel({ ...sent, label: 'Messaged @Customize: hello' })).toBe('Did not message a session');
      expect(toolRowLabel({ ...sent, status: 'error', label: 'Messaged @Customize: hello' })).toBe(
        'Failed to message a session'
      );
    });

    it('reads imported Claude Code task calls as plan updates', () => {
      expect(toolRowLabel(call('1', 'TaskCreate', { subject: 'x' }))).toBe('Added to the plan');
      expect(toolRowLabel(call('2', 'TaskUpdate', { taskId: '1', status: 'completed' }))).toBe('Updated the plan');
    });

    it('says plainly that it does not know an unregistered tool', () => {
      expect(toolRowLabel(call('1', 'future_tool', { path: 'x.ts' }))).toBe('Ran future_tool x.ts');
    });

    it('does not claim a failed or refused call happened', () => {
      expect(toolRowLabel(call('1', 'bash_execute', { command: 'echo x' }, 'denied'))).toBe('Did not run echo x');
      expect(toolRowLabel(call('2', 'file_read', { path: 'gone.ts' }, 'error'))).toBe('Failed to read gone.ts');
      expect(toolRowLabel(call('3', 'generate_image', { prompt: 'a bicycle' }, 'error'))).toBe(
        'Failed to generate an image'
      );
    });
  });

  describe('shortenArgument', () => {
    it('keeps short arguments whole', () => {
      expect(shortenArgument('src/app.ts')).toBe('src/app.ts');
    });

    it('cuts a long path from the front, where the identity is not', () => {
      const long = '/Users/someone/Javascript/checkout/apps/desktop/src/chat/ToolCallList.tsx';
      expect(shortenArgument(long)).toBe('.../chat/ToolCallList.tsx');
    });

    it('cuts anything else from the back, where its meaning is not', () => {
      const command = `echo ${'x'.repeat(80)}`;
      const short = shortenArgument(command);
      expect(short.startsWith('echo xxx')).toBe(true);
      expect(short.endsWith('...')).toBe(true);
      expect(short.length).toBeLessThanOrEqual(56);
    });

    it('flattens a multi-line argument onto the one line it has', () => {
      expect(shortenArgument('git status\ngit diff')).toBe('git status git diff');
    });
  });

  describe('groupToolCalls', () => {
    it('collapses consecutive calls to the same tool, with a count', () => {
      const groups = groupToolCalls([
        call('1', 'bash_execute', { command: 'a' }),
        call('2', 'bash_execute', { command: 'b' }),
        call('3', 'bash_execute', { command: 'c' }),
      ]);

      expect(groups).toHaveLength(1);
      expect(groups[0].label).toBe('Ran 3 commands');
      expect(groups[0].calls).toHaveLength(3);
    });

    it('folds a mixed run into one row, as a list in the order the tools ran', () => {
      const groups = groupToolCalls([
        call('1', 'bash_execute', { command: 'a' }),
        call('2', 'bash_execute', { command: 'b' }),
        call('3', 'file_read', { path: 'src/app.ts' }),
      ]);

      expect(groups).toHaveLength(1);
      expect(groups[0].label).toBe('Ran 2 commands, read src/app.ts');
      expect(groups[0].calls).toHaveLength(3);
    });

    // The count is a claim about a run, so two reads with a command between them are two clauses
    // and never "Read 2 files" - that would report a sequence the model never performed.
    it('counts only calls that really were consecutive', () => {
      const groups = groupToolCalls([
        call('1', 'file_read', { path: 'a.ts' }),
        call('2', 'bash_execute', { command: 'ls' }),
        call('3', 'file_read', { path: 'b.ts' }),
      ]);

      expect(groups.map(group => group.label)).toEqual(['Read a.ts, ran ls, read b.ts']);
    });

    it('breaks a run rather than composing a label too long to name what it covers', () => {
      const groups = groupToolCalls([
        call('1', 'file_read', { path: 'a.ts' }),
        call('2', 'bash_execute', { command: 'ls' }),
        call('3', 'grep_search', { pattern: 'handleClick' }),
        call('4', 'glob_files', { pattern: '*.ts' }),
        call('5', 'file_read', { path: 'b.ts' }),
        call('6', 'bash_execute', { command: 'pwd' }),
      ]);

      expect(groups).toHaveLength(2);
      expect(groups[0].label).toBe('Read a.ts, ran ls, searched for handleClick, searched for *.ts');
      expect(groups[1].label).toBe('Read b.ts, ran pwd');
    });

    it('leaves a call at the approval gate on its own row', () => {
      const groups = groupToolCalls([
        call('1', 'bash_execute', { command: 'a' }),
        call('2', 'bash_execute', { command: 'b' }, 'awaiting-approval'),
        call('3', 'bash_execute', { command: 'c' }),
      ]);

      expect(groups).toHaveLength(3);
      expect(groups[1].status).toBe('awaiting-approval');
      expect(groups[1].calls).toHaveLength(1);
    });

    // A count is written in the past tense, so a failure can never be inside one: "Read 2 files"
    // over a read that failed reports the opposite of what happened.
    it('reports a failure in a group rather than the successes around it', () => {
      const groups = groupToolCalls([
        call('1', 'file_read', { path: 'a.ts' }),
        call('2', 'file_read', { path: 'b.ts' }, 'error'),
      ]);

      expect(groups).toHaveLength(1);
      expect(groups[0].status).toBe('error');
      expect(groups[0].label).toBe('Read a.ts, failed to read b.ts');
    });

    it('keeps a refusal out of the count too', () => {
      const groups = groupToolCalls([
        call('1', 'bash_execute', { command: 'a' }),
        call('2', 'bash_execute', { command: 'b' }),
        call('3', 'bash_execute', { command: 'rm -rf /' }, 'denied'),
      ]);

      expect(groups[0].status).toBe('denied');
      expect(groups[0].label).toBe('Ran 2 commands, did not run rm -rf /');
    });

    it('keeps the spinner on a group whose last call is still running', () => {
      const groups = groupToolCalls([
        call('1', 'file_read', { path: 'a.ts' }),
        call('2', 'file_read', { path: 'b.ts' }, 'running'),
      ]);

      expect(groups[0].status).toBe('running');
    });

    // Beside the label, never inside it: the label is what the row ellipsizes, and these are the
    // two numbers a reader scanning a turn is counting on.
    it("carries the group's own total for the writes in it that landed", () => {
      const groups = groupToolCalls([
        call('1', 'bash_execute', { command: 'ls' }),
        wrote('2', '/repo/src/ChatService.ts', 9, 2),
      ]);

      expect(groups[0].label).toBe('Ran ls, edited /repo/src/ChatService.ts');
      expect(groups[0].diffstat).toEqual({ added: 9, removed: 2 });
    });

    it('sums the writes across a group rather than showing the last one', () => {
      const groups = groupToolCalls([wrote('1', '/repo/a.ts', 9, 2), wrote('2', '/repo/b.ts', 4, 0)]);

      expect(groups[0].label).toBe('Edited 2 files');
      expect(groups[0].diffstat).toEqual({ added: 13, removed: 2 });
    });

    // Every message stored before writes recorded a diff, and every group that wrote nothing.
    it('says nothing about lines when no call in the group has a diff', () => {
      const groups = groupToolCalls([
        call('1', 'file_edit', { path: 'a.ts' }),
        call('2', 'file_read', { path: 'b.ts' }),
      ]);

      expect(groups[0].label).toBe('Edited a.ts, read b.ts');
      expect(groups[0].diffstat).toBeUndefined();
      expect(diffTotals(groups[0].calls)).toBeUndefined();
    });

    // A create with nothing removed still has a total worth showing; only "no write at all" does
    // not, which is why this is not a truthiness check on the numbers.
    it('shows a total of zero removals rather than no total', () => {
      const groups = groupToolCalls([wrote('1', '/repo/new.ts', 28, 0)]);

      expect(groups[0].diffstat).toEqual({ added: 28, removed: 0 });
    });

    it('keys each group on its first call, so settling the rest does not remount it', () => {
      const first = groupToolCalls([call('1', 'file_read', {}, 'running')]);
      const second = groupToolCalls([call('1', 'file_read'), call('2', 'file_read', {}, 'running')]);

      expect(first[0].id).toBe('1');
      expect(second[0].id).toBe('1');
    });
  });

  describe('memory rows', () => {
    it('names the file a memory is, not the slug the tool was called with', () => {
      expect(toolRowLabel(call('1', 'memory_read', { name: 'local-backend-for-client-testing' }))).toBe(
        'Read local-backend-for-client-testing.md'
      );
      expect(toolRowLabel(call('2', 'memory_write', { name: 'a-fact' }))).toBe('Saved a-fact.md');
      expect(toolRowLabel(call('3', 'memory_delete', { name: 'a-fact' }))).toBe('Forgot a-fact.md');
    });

    it('heads a run of recalls with how many there were', () => {
      const groups = groupToolCalls([
        call('1', 'memory_read', { name: 'local-backend-for-client-testing' }),
        call('2', 'memory_read', { name: 'always-port-3000' }),
        call('3', 'memory_read', { name: 'testing-is-time-boxed' }),
      ]);

      expect(groups).toHaveLength(1);
      expect(groups[0].label).toBe('Recalled 3 memories');
      expect(groups[0].calls.map(member => toolRowLabel(member))).toEqual([
        'Read local-backend-for-client-testing.md',
        'Read always-port-3000.md',
        'Read testing-is-time-boxed.md',
      ]);
    });

    it('says what it failed to do rather than claiming it recalled anything', () => {
      expect(toolRowLabel(call('1', 'memory_read', { name: 'a-fact' }, 'error'))).toBe('Failed to read a-fact.md');
      expect(toolRowLabel(call('2', 'memory_write', { name: 'a-fact' }, 'denied'))).toBe('Did not save a-fact.md');
    });
  });

  describe('apply_patch rows', () => {
    const patched = (extra: Partial<ChatToolCall> = {}): ChatToolCall => ({
      ...call('1', 'apply_patch', { patchText: '*** Begin Patch\n*** End Patch' }),
      ...extra,
    });
    const diff = (path: string, added: number, removed: number): ChatDiff => ({
      path,
      operation: 'edit',
      added,
      removed,
      lines: [],
    });

    it('uses the label the tool set, and a patch phrase otherwise', () => {
      expect(toolRowLabel(patched({ label: 'Edited 3 files' }))).toBe('Edited 3 files');
      expect(toolRowLabel(patched({ label: 'Patched app.ts' }))).toBe('Patched app.ts');
      expect(toolRowLabel(patched())).toBe('Patched files');
    });

    it('does not claim a failed or declined patch happened', () => {
      expect(toolRowLabel(patched({ status: 'error', label: 'Edited 3 files' }))).toBe('Failed to apply a patch');
      expect(toolRowLabel(patched({ status: 'denied' }))).toBe('Did not apply a patch');
    });

    it('counts the diffs of a multi-file patch in the group total', () => {
      const several = patched({ diffs: [diff('/r/a.ts', 3, 1), diff('/r/b.ts', 2, 0)] });
      expect(diffTotals([several, wrote('2', '/r/c.ts', 1, 1)])).toEqual({ added: 6, removed: 2 });
      expect(groupToolCalls([several])[0].diffstat).toEqual({ added: 5, removed: 1 });
    });
  });

  describe('browser_scroll rows', () => {
    it('reads as where the page was scrolled to, from the label the tool wrote', () => {
      const scrolled = call('1', 'browser_scroll', { direction: 'down' });
      expect(toolRowLabel({ ...scrolled, label: 'Scrolled down' })).toBe('Scrolled down');
      expect(toolRowLabel(call('2', 'browser_scroll', { text: 'Pricing' }))).toBe('Scrolled to Pricing');
    });

    it('does not claim a scroll that failed', () => {
      expect(toolRowLabel(call('1', 'browser_scroll', { text: 'Pricing' }, 'error'))).toBe(
        'Failed to scroll to Pricing'
      );
      expect(toolRowLabel(call('2', 'browser_scroll', { ref: '12' }, 'error'))).toBe('Failed to scroll the page');
    });

    it('counts a run of scrolls', () => {
      const [group] = groupToolCalls([call('1', 'browser_scroll'), call('2', 'browser_scroll')]);
      expect(group.label).toBe('Scrolled 2 times');
    });
  });

  describe('browser_tabs rows', () => {
    it('reads as what happened to the tabs, from the label the tool wrote', () => {
      const opened = call('1', 'browser_tabs', { action: 'new', url: 'https://example.com' });
      expect(toolRowLabel({ ...opened, label: 'Opened tab: example.com' })).toBe('Opened tab: example.com');
      expect(
        toolRowLabel({ ...call('2', 'browser_tabs', { action: 'select', id: 2 }), label: 'Switched to tab: Docs' })
      ).toBe('Switched to tab: Docs');
    });

    it('does not claim a tab change that failed', () => {
      expect(toolRowLabel(call('1', 'browser_tabs', { action: 'select', id: 9 }, 'error'))).toBe(
        'Failed to change browser tabs'
      );
    });
  });

  describe('a spawn refused only for its model request', () => {
    const refused = (id: string): ChatToolCall => ({
      ...call(id, 'session_spawn', { title: 'Worker', requested_model_id: 'sonnet' }, 'error'),
      error: `${MODEL_REQUEST_REFUSED} 'sonnet' is not an allowed override (allowed: none).`,
    });

    it('reads as muted, while any other spawn failure stays an error', () => {
      expect(toolRowLabel(refused('1'))).toBe('Not started: model sonnet is not allowed');
      const started = { ...call('2', 'session_spawn', { title: 'Worker' }), label: 'Started a session: Worker' };
      const [group] = groupToolCalls([refused('1'), started]);
      expect(group.status).toBe('done');
      expect(group.label).toBe('Not started: model sonnet is not allowed, started a session: Worker');
      expect(groupToolCalls([refused('4'), refused('5'), refused('6')])[0].label).toBe(
        'Not started: model sonnet is not allowed (3 requests)'
      );
      const opus = { ...refused('7'), input: { requested_model_id: 'opus' } };
      expect(groupToolCalls([refused('8'), opus])[0].label).toBe('Not started: 2 model requests were not allowed');
      const blocked = { ...refused('3'), error: 'Worker model x is blocked: not in the connected catalog.' };
      expect(groupToolCalls([blocked])[0]).toMatchObject({ status: 'error', label: 'Failed to start a session' });
    });
  });
});
