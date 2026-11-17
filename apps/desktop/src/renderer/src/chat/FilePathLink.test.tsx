// @vitest-environment jsdom
import { CssVarsProvider } from '@mui/joy/styles';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatFilePathActionResult, ChatFilePathOpenResult, ChatFileView } from '@shared/chat';
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

const checkFilePaths = vi.fn(async (_sessionId: string, paths: string[]): Promise<(string | null)[]> =>
  paths.map(path => EXISTING[path] ?? null)
);
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

const filePathAction = vi.fn(
  async (_sessionId: string, _path: string, _action: string): Promise<ChatFilePathActionResult> => ({ ok: true })
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
  filePathAction.mockClear();
  vi.stubGlobal('b4m', {
    chat: { checkFilePaths, openFilePath, readFilePath, filePathAction },
    shell: { openExternal: vi.fn() },
  });
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

  it("asks again for another conversation rather than reusing the last one's answers", async () => {
    const reply = <ReplyMarkdown text="See reports/run.webm" />;
    await render(<FilePathLinkProvider sessionId="s1">{reply}</FilePathLinkProvider>);
    expect(links()).toHaveLength(1);

    checkFilePaths.mockImplementationOnce(async (_sessionId, paths) => paths.map(() => null));
    await render(<FilePathLinkProvider sessionId="s2">{reply}</FilePathLinkProvider>);

    expect(checkFilePaths).toHaveBeenLastCalledWith('s2', ['reports/run.webm']);
    expect(links()).toHaveLength(0);
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

describe('the file link context menu', () => {
  const onAttach = vi.fn(async (_path: string) => {});
  const showFile = vi.fn();
  beforeEach(() => {
    onAttach.mockClear();
    showFile.mockClear();
  });

  const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

  async function openMenu(attach = true) {
    await render(
      <FilePathLinkProvider sessionId="s1" showFile={showFile} onAttach={attach ? onAttach : undefined}>
        <ReplyMarkdown text="See `package.json:2`" />
      </FilePathLinkProvider>
    );
    await act(async () => {
      links()[0].dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 })
      );
    });
  }

  it('opens on right-click with every item', async () => {
    EXISTING['package.json:2'] = '/work/project/package.json';
    try {
      await openMenu();
      for (const id of [
        'file-link-menu-open-btn',
        'file-link-menu-open-external-btn',
        'file-link-menu-attach-btn',
        'file-link-menu-copy-submenu-btn',
        'file-link-menu-reveal-btn',
      ]) {
        expect(byTestId(id), id).not.toBeNull();
      }
    } finally {
      delete EXISTING['package.json:2'];
    }
  });

  it('leaves Attach out where there is no composer', async () => {
    EXISTING['package.json:2'] = '/work/project/package.json';
    try {
      await openMenu(false);
      expect(byTestId('file-link-menu-open-btn')).not.toBeNull();
      expect(byTestId('file-link-menu-attach-btn')).toBeNull();
    } finally {
      delete EXISTING['package.json:2'];
    }
  });

  it('attaches, reveals and copies the path as the reply wrote it', async () => {
    EXISTING['package.json:2'] = '/work/project/package.json';
    try {
      await openMenu();
      await act(async () => byTestId('file-link-menu-attach-btn')!.click());
      expect(onAttach).toHaveBeenCalledWith('package.json:2');

      await openMenu();
      await act(async () => byTestId('file-link-menu-reveal-btn')!.click());
      expect(filePathAction).toHaveBeenCalledWith('s1', 'package.json:2', 'reveal');

      await openMenu();
      await act(async () => byTestId('file-link-menu-copy-submenu-btn')!.click());
      await act(async () => byTestId('file-link-menu-copy-relative-path-btn')!.click());
      expect(filePathAction).toHaveBeenCalledWith('s1', 'package.json:2', 'copy-relative-path');
      expect(byTestId('file-link-menu-copy-submenu')).toBeNull();
    } finally {
      delete EXISTING['package.json:2'];
    }
  });

  it('opens in the pane or in another app from the menu', async () => {
    EXISTING['package.json:2'] = '/work/project/package.json';
    VIEWS['package.json:2'] = VIEWS['package.json'];
    try {
      await openMenu();
      await act(async () => byTestId('file-link-menu-open-btn')!.click());
      expect(showFile).toHaveBeenCalledWith('package.json:2', VIEWS['package.json']);

      await openMenu();
      await act(async () => byTestId('file-link-menu-open-external-btn')!.click());
      expect(openFilePath).toHaveBeenCalledWith('s1', 'package.json:2');
    } finally {
      delete EXISTING['package.json:2'];
      delete VIEWS['package.json:2'];
    }
  });

  it('says what went wrong when an action fails', async () => {
    EXISTING['package.json:2'] = '/work/project/package.json';
    filePathAction.mockResolvedValueOnce({ ok: false, error: 'That file no longer exists.' });
    try {
      await openMenu();
      await act(async () => byTestId('file-link-menu-reveal-btn')!.click());
      expect(byTestId('file-link-error-notice')?.textContent).toContain('That file no longer exists.');
    } finally {
      delete EXISTING['package.json:2'];
    }
  });

  it('opens from the keyboard with Shift+F10', async () => {
    EXISTING['package.json:2'] = '/work/project/package.json';
    try {
      await render(
        <FilePathLinkProvider sessionId="s1">
          <ReplyMarkdown text="See `package.json:2`" />
        </FilePathLinkProvider>
      );
      await act(async () => {
        links()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
      });
      expect(byTestId('file-link-menu-open-btn')).not.toBeNull();
      expect(openFilePath).not.toHaveBeenCalled();
    } finally {
      delete EXISTING['package.json:2'];
    }
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
