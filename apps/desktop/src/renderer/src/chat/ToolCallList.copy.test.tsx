// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatToolCall } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolCallList } from './ToolCallList';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
            bash({ input: { command: 'rm -rf dist' }, status: 'awaiting-approval', approvalId: 'a1', approvalDetail }),
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
