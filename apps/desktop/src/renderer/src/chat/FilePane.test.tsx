// @vitest-environment jsdom
import { CssVarsProvider } from '@mui/joy/styles';
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatFilePathOpenResult, ChatFileView } from '@shared/chat';
import { desktopTheme } from '../theme';
import { FilePane, languageFor, type TextFileView } from './FilePane';

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

const VIEW: TextFileView = {
  kind: 'text',
  path: '/work/project/src/app.ts',
  name: 'app.ts',
  size: 40,
  text: 'const a = 1;\nconst b = 2;\nconst c = 3;\n',
  truncated: false,
};

const readFilePath = vi.fn(async (_sessionId: string, _path: string): Promise<ChatFileView> => VIEW);

let root: Root;
let container: HTMLDivElement;
const onOpenExternally = vi.fn(async (_requested: string): Promise<ChatFilePathOpenResult> => ({
  ok: true,
  opened: 'opened',
}));
const onClose = vi.fn();
const conversation = createRef<HTMLElement>();

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function render(view: TextFileView, refreshKey: unknown = 0, requested = 'src/app.ts:2') {
  await act(async () =>
    root.render(
      <CssVarsProvider theme={desktopTheme}>
        <FilePane
          sessionId="s1"
          requested={requested}
          view={view}
          refreshKey={refreshKey}
          conversation={conversation}
          onOpenExternally={onOpenExternally}
          onClose={onClose}
        />
      </CssVarsProvider>
    )
  );
}

beforeEach(() => {
  readFilePath.mockClear();
  onOpenExternally.mockClear();
  onClose.mockClear();
  vi.stubGlobal('b4m', { chat: { readFilePath } });
  Element.prototype.scrollIntoView ??= () => {};
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('FilePane', () => {
  it('shows the file with its name, full path and line numbers', async () => {
    await render(VIEW);

    expect(byTestId('file-pane-title')?.textContent).toBe('app.ts');
    expect(byTestId('file-pane')?.textContent).toContain('/work/project/src/app.ts');
    const body = byTestId('file-pane-body')!;
    expect(body.textContent).toContain('const b = 2;');
    expect(body.querySelectorAll('[data-line]')).toHaveLength(3);
    expect(byTestId('file-pane-truncated')).toBeNull();
  });

  it('marks the cited line and brings it into view', async () => {
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView');
    await render({ ...VIEW, line: 2 });

    const line = byTestId('file-pane-body')!.querySelector<HTMLElement>('[data-line="2"]')!;
    expect(line.style.backgroundColor).toContain('warning-softBg');
    // Scrolled on the first, plain draw; the highlighted copy that replaces it keeps the layout.
    expect(scrolled.mock.contexts.map(element => (element as HTMLElement).dataset.line)).toContain('2');
    scrolled.mockRestore();
  });

  it('ends up highlighted after the plain first draw', async () => {
    await render(VIEW);
    expect(byTestId('file-pane-body')!.querySelector('.token')?.textContent).toBe('const');
  });

  it('says when it shows only the start of a long file', async () => {
    await render({ ...VIEW, size: 5 * 1024 * 1024, truncated: true });
    expect(byTestId('file-pane-truncated')?.textContent).toContain('of 5.0 MB');
  });

  it('opens the path as the reply wrote it in another app, and closes', async () => {
    await render(VIEW);
    await act(async () => byTestId('file-pane-open-external-btn')!.click());
    await act(async () => byTestId('file-pane-close-btn')!.click());

    expect(onOpenExternally).toHaveBeenCalledWith('src/app.ts:2');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('says why when the file cannot be opened in another app', async () => {
    onOpenExternally.mockResolvedValueOnce({ ok: false, error: 'No app can open this file.' });
    await render(VIEW);
    await act(async () => byTestId('file-pane-open-external-btn')!.click());

    expect(byTestId('file-pane-error')?.textContent).toContain('No app can open this file.');
  });

  it('reads the file again when a turn settles, and on Reload', async () => {
    await render(VIEW, 0);
    expect(readFilePath).not.toHaveBeenCalled();

    readFilePath.mockResolvedValueOnce({ ...VIEW, text: 'const changed = true;\n' });
    await render(VIEW, 1);
    expect(readFilePath).toHaveBeenCalledWith('s1', 'src/app.ts:2');
    expect(byTestId('file-pane-body')?.textContent).toContain('const changed = true;');

    await act(async () => byTestId('file-pane-reload-btn')!.click());
    expect(readFilePath).toHaveBeenCalledTimes(2);
  });

  it.each(['text', 'error', 'rejection'] as const)(
    'ignores an older file reload %s after selecting another file',
    async outcome => {
      let resolve!: (view: ChatFileView) => void;
      let reject!: (error: Error) => void;
      readFilePath.mockImplementationOnce(
        () =>
          new Promise((done, fail) => {
            resolve = done;
            reject = fail;
          })
      );
      await render({ ...VIEW, line: 2 });
      await act(async () => byTestId('file-pane-reload-btn')!.click());
      const next = { ...VIEW, path: '/work/project/next.md', name: 'next.md', text: '# next selection' };
      await render(next, 0, 'next.md');
      await act(async () => {
        if (outcome === 'rejection') reject(new Error('old read rejected'));
        else
          resolve(outcome === 'text' ? { ...VIEW, text: 'stale contents' } : { kind: 'error', error: 'stale failure' });
      });
      expect(byTestId('file-pane')?.dataset.path).toBe(next.path);
      expect(byTestId('file-pane-body')?.textContent).toContain('# next selection');
      expect(byTestId('file-pane-error')).toBeNull();
      await act(async () => byTestId('file-pane-open-external-btn')!.click());
      expect(onOpenExternally).toHaveBeenLastCalledWith('next.md');
      expect(byTestId('file-pane-body')?.querySelector('[data-line="2"]')).toBeNull();
    }
  );

  it('does not revive an old reload after switching away and back to the same path', async () => {
    let resolve!: (view: ChatFileView) => void;
    readFilePath.mockImplementationOnce(
      () =>
        new Promise(done => {
          resolve = done;
        })
    );
    await render(VIEW);
    await act(async () => byTestId('file-pane-reload-btn')!.click());
    await render({ ...VIEW, path: '/work/project/next.md', name: 'next.md' }, 0, 'next.md');
    await render({ ...VIEW, text: 'fresh selection' });
    await act(async () => resolve({ ...VIEW, text: 'stale reload' }));
    expect(byTestId('file-pane-body')?.textContent).toContain('fresh selection');
  });

  it('ignores an external-open failure belonging to the previous selection', async () => {
    let resolve!: (result: ChatFilePathOpenResult) => void;
    onOpenExternally.mockImplementationOnce(
      () =>
        new Promise(done => {
          resolve = done;
        })
    );
    await render(VIEW);
    await act(async () => byTestId('file-pane-open-external-btn')!.click());
    await render({ ...VIEW, path: '/work/project/next.md', name: 'next.md' }, 0, 'next.md');
    await act(async () => resolve({ ok: false, error: 'old application failure' }));
    expect(byTestId('file-pane-error')).toBeNull();
  });

  it('keeps the newest of two same-file reloads', async () => {
    let resolve!: (view: ChatFileView) => void;
    readFilePath.mockImplementationOnce(
      () =>
        new Promise(done => {
          resolve = done;
        })
    );
    await render(VIEW);
    await act(async () => byTestId('file-pane-reload-btn')!.click());
    readFilePath.mockResolvedValueOnce({ ...VIEW, text: 'newest contents' });
    await act(async () => byTestId('file-pane-reload-btn')!.click());
    await act(async () => resolve({ ...VIEW, text: 'older contents' }));
    expect(byTestId('file-pane-body')?.textContent).toContain('newest contents');
  });

  it('reports a rejected current reload while retaining the file', async () => {
    await render(VIEW);
    readFilePath.mockRejectedValueOnce(new Error('current read failed'));
    await act(async () => byTestId('file-pane-reload-btn')!.click());
    expect(byTestId('file-pane-error')?.textContent).toContain('current read failed');
    expect(byTestId('file-pane-body')?.textContent).toContain('const a = 1;');
  });

  it('keeps the last good copy and says why when a reload fails', async () => {
    await render(VIEW, 0);
    readFilePath.mockResolvedValueOnce({ kind: 'error', error: 'That file no longer exists.' });
    await render(VIEW, 1);

    expect(byTestId('file-pane-error')?.textContent).toContain('That file no longer exists.');
    expect(byTestId('file-pane-body')?.textContent).toContain('const a = 1;');
  });
});

describe('languageFor', () => {
  it('picks a highlighter language from the file name', () => {
    expect(languageFor('app.ts')).toBe('typescript');
    expect(languageFor('View.TSX')).toBe('tsx');
    expect(languageFor('ci.yml')).toBe('yaml');
    expect(languageFor('Dockerfile')).toBe('docker');
    expect(languageFor('notes')).toBe('text');
    expect(languageFor('data.unknownext')).toBe('text');
  });
});
