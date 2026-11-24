// @vitest-environment jsdom
import { CssVarsProvider } from '@mui/joy/styles';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReplyMarkdown } from './ReplyMarkdown';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom ships no matchMedia, and Joy's colour-scheme provider asks for one on mount.
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

const writeText = vi.fn<(text: string) => Promise<void>>();
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(text: string): void {
  act(() =>
    root.render(
      <CssVarsProvider>
        <ReplyMarkdown text={text} />
      </CssVarsProvider>
    )
  );
}

const all = (testId: string) => [...container.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)];

describe('ReplyMarkdown code block copy', () => {
  it("copies each block's own raw text, not its highlighted markup or the prose around it", async () => {
    const first = 'const x: number = 1;\nconsole.log(`${x} <b>`);';
    const second = 'echo "hi" && ls -la';
    render(`Intro.\n\n\`\`\`ts\n${first}\n\`\`\`\n\nBetween.\n\n\`\`\`bash\n${second}\n\`\`\`\n`);

    const buttons = all('reply-codeblock-copy-btn');
    expect(buttons).toHaveLength(2);
    expect(buttons[0].getAttribute('aria-label')).toBe('Copy code');

    await act(async () => buttons[1].click());
    expect(writeText).toHaveBeenLastCalledWith(second);

    await act(async () => buttons[0].click());
    expect(writeText).toHaveBeenLastCalledWith(first);
    expect(buttons[0].getAttribute('aria-label')).toBe('Copied');
  });

  it('labels a block with its language, and an unhinted block with none', () => {
    render('```python\nx = 1\n```\n\n```\nplain\n```');
    expect(all('reply-codeblock-copy-btn')).toHaveLength(2);
    expect(all('reply-codeblock-language').map(label => label.textContent)).toEqual(['python']);
  });

  it('copies an empty fence as an empty string', async () => {
    render('```\n```');
    await act(async () => all('reply-codeblock-copy-btn')[0].click());
    expect(writeText).toHaveBeenCalledWith('');
  });

  it('gives inline code no copy button', () => {
    render('Run `pnpm build` first.');
    expect(all('reply-codeblock-copy-btn')).toHaveLength(0);
  });
});
