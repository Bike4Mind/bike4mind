// @vitest-environment jsdom
import { CssVarsProvider } from '@mui/joy/styles';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatImageActionResult, ChatMedia, ChatToolCall } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageMenuProvider } from './ImageContextMenu';
import { ToolCallList } from './ToolCallList';

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
