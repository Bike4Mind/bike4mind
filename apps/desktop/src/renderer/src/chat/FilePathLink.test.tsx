// @vitest-environment jsdom
import { CssVarsProvider } from '@mui/joy/styles';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatFilePathOpenResult, ChatFileView } from '@shared/chat';
import { FilePathLinkProvider } from './FilePathLink';
import { ReplyMarkdown } from './markdown/ReplyMarkdown';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

const EXISTING: Record<string, string> = {
  'reports/run.webm': '/work/project/reports/run.webm',
  'package.json': '/work/project/package.json',
};

const checkFilePaths = vi.fn(async (_sessionId: string, paths: string[]) => paths.map(path => EXISTING[path] ?? null));
const openFilePath = vi.fn(async (_sessionId: string, _path: string): Promise<ChatFilePathOpenResult> => ({
  ok: true,
  opened: 'opened',
}));

const VIEWS: Record<string, ChatFileView> = {
  'reports/run.webm': { kind: 'binary', path: '/work/project/reports/run.webm', name: 'run.webm', size: 5 },
  'package.json': {
    kind: 'text',
    path: '/work/project/package.json',
    name: 'package.json',
    size: 2,
    text: '{}',
    truncated: false,
  },
};
const readFilePath = vi.fn(
  async (_sessionId: string, path: string): Promise<ChatFileView> =>
    VIEWS[path] ?? { kind: 'error', error: 'That file no longer exists.' }
);

let root: Root;
let container: HTMLDivElement;

async function render(node: ReactNode) {
  await act(async () => root.render(<CssVarsProvider>{node}</CssVarsProvider>));
  // The provider batches on a timer; let it flush and its answers land.
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

const links = () => Array.from(document.querySelectorAll<HTMLElement>('[data-testid="chat-markdown-file-link"]'));

beforeEach(() => {
  checkFilePaths.mockClear();
  openFilePath.mockClear();
  readFilePath.mockClear();
  vi.stubGlobal('b4m', { chat: { checkFilePaths, openFilePath, readFilePath }, shell: { openExternal: vi.fn() } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('file path links in a reply', () => {
  it('links only the paths main found, in one batch', async () => {
    await render(
      <FilePathLinkProvider sessionId="s1">
        <ReplyMarkdown text={'Saved reports/run.webm and `package.json`, not reports/gone.webm or and/or.'} />
      </FilePathLinkProvider>
    );

    expect(checkFilePaths).toHaveBeenCalledTimes(1);
    expect(checkFilePaths.mock.calls[0][0]).toBe('s1');
    expect([...checkFilePaths.mock.calls[0][1]].sort()).toEqual(
      ['and/or', 'package.json', 'reports/gone.webm', 'reports/run.webm'].sort()
    );
    expect(links().map(link => link.textContent)).toEqual(['reports/run.webm', 'package.json']);
    expect(links()[0].getAttribute('title')).toBe('/work/project/reports/run.webm');
    // The inline code chip is kept inside its link.
    expect(links()[1].querySelector('[data-testid="chat-markdown-inline-code"]')).not.toBeNull();
    expect(container.textContent).toContain('not reports/gone.webm or and/or.');
  });

  it('opens the path as the reply wrote it, by click and by Enter', async () => {
    await render(
      <FilePathLinkProvider sessionId="s1">
        <ReplyMarkdown text="See reports/run.webm" />
      </FilePathLinkProvider>
    );
    await act(async () => links()[0].click());
    await act(async () => {
      links()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(openFilePath).toHaveBeenCalledTimes(2);
    expect(openFilePath).toHaveBeenCalledWith('s1', 'reports/run.webm');
  });

  it('shows what went wrong when a link cannot open', async () => {
    openFilePath.mockResolvedValueOnce({ ok: false, error: 'That file no longer exists.' });
    await render(
      <FilePathLinkProvider sessionId="s1">
        <ReplyMarkdown text="See reports/run.webm" />
      </FilePathLinkProvider>
    );
    await act(async () => links()[0].click());

    expect(document.querySelector('[data-testid="file-link-error-notice"]')?.textContent).toContain(
      'That file no longer exists.'
    );
  });

  it('asks again about a path it did not find once a turn settles', async () => {
    const reply = <ReplyMarkdown text="Writing out/report.md next" />;
    await render(
      <FilePathLinkProvider sessionId="s1" recheck={0}>
        {reply}
      </FilePathLinkProvider>
    );
    expect(links()).toHaveLength(0);

    EXISTING['out/report.md'] = '/work/project/out/report.md';
    try {
      await render(
        <FilePathLinkProvider sessionId="s1" recheck={1}>
          {reply}
        </FilePathLinkProvider>
      );
      expect(checkFilePaths).toHaveBeenCalledTimes(2);
      expect(links().map(link => link.textContent)).toEqual(['out/report.md']);
    } finally {
      delete EXISTING['out/report.md'];
    }
  });

  it('draws paths as plain text with no conversation open', async () => {
    await render(
      <FilePathLinkProvider sessionId={null}>
        <ReplyMarkdown text="See reports/run.webm" />
      </FilePathLinkProvider>
    );
    expect(checkFilePaths).not.toHaveBeenCalled();
    expect(links()).toHaveLength(0);
    expect(container.textContent).toContain('See reports/run.webm');
  });
});

describe('where a file path link opens', () => {
  const showFile = vi.fn();
  beforeEach(() => showFile.mockClear());

  const renderWithPane = () =>
    render(
      <FilePathLinkProvider sessionId="s1" showFile={showFile}>
        <ReplyMarkdown text="See `package.json` and reports/run.webm" />
      </FilePathLinkProvider>
    );
  const link = (text: string) => links().find(element => element.textContent === text)!;

  it('shows a text file in the app', async () => {
    await renderWithPane();
    await act(async () => link('package.json').click());

    expect(readFilePath).toHaveBeenCalledWith('s1', 'package.json');
    expect(showFile).toHaveBeenCalledWith('package.json', VIEWS['package.json']);
    expect(openFilePath).not.toHaveBeenCalled();
  });

  it('hands a file the pane cannot show to the OS', async () => {
    await renderWithPane();
    await act(async () => link('reports/run.webm').click());

    expect(showFile).not.toHaveBeenCalled();
    expect(openFilePath).toHaveBeenCalledWith('s1', 'reports/run.webm');
  });

  it('opens in another app on a modifier click, without reading the file', async () => {
    await renderWithPane();
    await act(async () => {
      // Both modifiers, so the test holds on any platform the suite runs on.
      link('package.json').dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true, ctrlKey: true })
      );
    });

    expect(readFilePath).not.toHaveBeenCalled();
    expect(showFile).not.toHaveBeenCalled();
    expect(openFilePath).toHaveBeenCalledWith('s1', 'package.json');
  });
});
