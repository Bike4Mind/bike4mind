// @vitest-environment jsdom
import { CssVarsProvider } from '@mui/joy/styles';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AddAttachmentsResult, ChatAttachment, ChatImageActionResult, ChatMedia } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttachmentRow } from './Attachments';
import { ImageMenuProvider } from './ImageContextMenu';
import { MediaAttachments } from './MediaAttachment';
import { ReplyMarkdown } from './markdown/ReplyMarkdown';
import { useAttachmentDraft } from './useAttachments';

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

const ATTACHMENT: ChatAttachment = {
  id: 'a1',
  kind: 'image',
  name: 'pasted.png',
  mediaType: 'image/png',
  byteSize: 10,
  sourceBytes: 10,
};

const SCREENSHOT: ChatMedia = {
  kind: 'image',
  url: 'b4m-media://media/s1/00000000-0000-4000-8000-000000000000.png',
  mimeType: 'image/png',
  byteLength: 10,
  caption: 'https://example.com',
};

const ITEM_IDS = [
  'image-menu-copy-btn',
  'image-menu-save-btn',
  'image-menu-attach-btn',
  'image-menu-copy-submenu-btn',
  'image-menu-reveal-btn',
];

const imageAction = vi.fn(async (..._args: unknown[]): Promise<ChatImageActionResult> => ({ ok: true, done: true }));
const attachImage = vi.fn(async (..._args: unknown[]): Promise<AddAttachmentsResult> => ({
  attachments: [{ ...ATTACHMENT, id: 'a2', name: 'screenshot.png' }],
  rejected: [],
}));

let root: Root;
let container: HTMLDivElement;

async function render(node: ReactNode) {
  await act(async () => root.render(<CssVarsProvider>{node}</CssVarsProvider>));
}

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const menuItems = () => ITEM_IDS.filter(id => byTestId(id) !== null);

async function rightClick(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 }));
  });
}

async function click(id: string) {
  const element = byTestId(id);
  if (!element) throw new Error(`${id} is missing`);
  await act(async () => element.click());
}

beforeEach(() => {
  imageAction.mockClear();
  attachImage.mockClear();
  vi.stubGlobal('b4m', {
    chat: {
      readAttachment: async () => 'data:image/png;base64,AAAA',
      imageAction,
      attachImage,
      addAttachments: vi.fn(),
      pickAttachments: vi.fn(),
      discardAttachment: vi.fn(),
    },
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

describe('the image context menu', () => {
  it('offers every item on a user attachment', async () => {
    await render(
      <ImageMenuProvider onAttach={async () => {}}>
        <AttachmentRow sessionId="s1" attachments={[ATTACHMENT]} />
      </ImageMenuProvider>
    );
    await rightClick(byTestId('attachment-view-btn')!);

    expect(byTestId('image-context-menu')).not.toBeNull();
    expect(menuItems()).toEqual(ITEM_IDS);
  });

  it('saves a tool screenshot by its media url and stays quiet when the dialog is cancelled', async () => {
    imageAction.mockResolvedValueOnce({ ok: true, done: false });
    await render(
      <ImageMenuProvider onAttach={async () => {}}>
        <MediaAttachments media={[SCREENSHOT]} nameHint="screenshot" />
      </ImageMenuProvider>
    );
    await rightClick(byTestId('chat-media-view-btn')!);
    expect(menuItems()).toEqual(ITEM_IDS);

    await click('image-menu-save-btn');

    expect(imageAction).toHaveBeenCalledWith({ source: 'media', url: SCREENSHOT.url, nameHint: 'screenshot' }, 'save');
    expect(byTestId('image-context-menu')).toBeNull();
    expect(byTestId('image-menu-error-notice')).toBeNull();
  });

  it('opens the Copy submenu with image, path and Markdown for a file on disk', async () => {
    await render(
      <ImageMenuProvider>
        <MediaAttachments media={[SCREENSHOT]} />
      </ImageMenuProvider>
    );
    await rightClick(byTestId('chat-media-view-btn')!);
    // No composer to attach to: the item is hidden, not disabled.
    expect(byTestId('image-menu-attach-btn')).toBeNull();

    await click('image-menu-copy-submenu-btn');
    expect(byTestId('image-menu-copy-submenu')).not.toBeNull();
    expect(byTestId('image-context-menu')).not.toBeNull();
    for (const id of ['image-menu-copy-image-btn', 'image-menu-copy-path-btn', 'image-menu-copy-markdown-btn']) {
      expect(byTestId(id)).not.toBeNull();
    }

    await click('image-menu-copy-path-btn');
    expect(imageAction).toHaveBeenCalledWith(expect.objectContaining({ source: 'media' }), 'copy-path');
  });

  it('offers only the Markdown of a remote image in a reply', async () => {
    await render(
      <ImageMenuProvider onAttach={async () => {}}>
        <ReplyMarkdown text="![chart](https://example.com/chart.png)" />
      </ImageMenuProvider>
    );
    const image = byTestId('chat-markdown-image')!;
    expect(image.getAttribute('tabindex')).toBe('0');
    await rightClick(image);

    expect(menuItems()).toEqual(['image-menu-copy-submenu-btn']);
    await click('image-menu-copy-submenu-btn');
    expect(byTestId('image-menu-copy-image-btn')).toBeNull();
    expect(byTestId('image-menu-copy-path-btn')).toBeNull();

    await click('image-menu-copy-markdown-btn');
    expect(imageAction).toHaveBeenCalledWith(
      { source: 'remote', url: 'https://example.com/chart.png' },
      'copy-markdown'
    );
  });

  it('shows a failed action as a notice', async () => {
    imageAction.mockResolvedValueOnce({ ok: false, error: 'That image is no longer available.' });
    await render(
      <ImageMenuProvider>
        <MediaAttachments media={[SCREENSHOT]} />
      </ImageMenuProvider>
    );
    await rightClick(byTestId('chat-media-view-btn')!);
    await click('image-menu-copy-btn');

    expect(byTestId('image-menu-error-notice')?.textContent).toContain('That image is no longer available.');
  });

  it('opens from the keyboard and closes on Escape', async () => {
    await render(
      <ImageMenuProvider>
        <MediaAttachments media={[SCREENSHOT]} />
      </ImageMenuProvider>
    );
    const button = byTestId('chat-media-view-btn')!;
    await act(async () => {
      button.focus();
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
    });
    expect(byTestId('image-context-menu')).not.toBeNull();

    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(byTestId('image-context-menu')).toBeNull();
  });

  it('opens no menu outside a provider', async () => {
    await render(<MediaAttachments media={[SCREENSHOT]} />);
    await rightClick(byTestId('chat-media-view-btn')!);
    expect(byTestId('image-context-menu')).toBeNull();
  });

  it('attaches a thread image to the composer draft', async () => {
    function Shell() {
      const draft = useAttachmentDraft('s1');
      return (
        <>
          <ImageMenuProvider onAttach={draft.attachImage}>
            <MediaAttachments media={[SCREENSHOT]} nameHint="screenshot" />
          </ImageMenuProvider>
          <div data-testid="composer-draft">
            <AttachmentRow sessionId="s1" attachments={draft.attachments} onRemove={draft.remove} />
          </div>
        </>
      );
    }
    await render(<Shell />);
    const composer = () => byTestId('composer-draft')!;
    expect(composer().querySelectorAll('[data-testid="attachment-tile"]')).toHaveLength(0);

    await rightClick(byTestId('chat-media-view-btn')!);
    await click('image-menu-attach-btn');

    expect(attachImage).toHaveBeenCalledWith('s1', { source: 'media', url: SCREENSHOT.url, nameHint: 'screenshot' });
    expect(composer().querySelectorAll('[data-testid="attachment-tile"]')).toHaveLength(1);
    expect(composer().textContent).toContain('screenshot.png');
    // The composer's own tiles sit outside the provider, so they offer no menu of their own.
    await rightClick(composer().querySelector('[data-testid="attachment-view-btn"]')!);
    expect(byTestId('image-context-menu')).toBeNull();
  });
});
