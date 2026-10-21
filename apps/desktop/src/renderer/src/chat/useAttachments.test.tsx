// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AddAttachmentsResult, ChatAttachment, ChatImageRef } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAttachmentDraft, type AttachmentDraft } from './useAttachments';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ATTACHMENT: ChatAttachment = {
  id: 'a1',
  kind: 'image',
  name: 'screenshot.png',
  mediaType: 'image/png',
  byteSize: 10,
  sourceBytes: 10,
};

const IMAGE: ChatImageRef = {
  source: 'media',
  url: 'b4m-media://media/s1/00000000-0000-4000-8000-000000000000.png',
  nameHint: 'screenshot',
};

const attachImage = vi.fn<(sessionId: string, image: ChatImageRef) => Promise<AddAttachmentsResult>>();

let root: Root;
let host: HTMLElement;
let draft: AttachmentDraft;

function HookHost({ sessionId }: { sessionId: string | null }) {
  draft = useAttachmentDraft(sessionId);
  return null;
}

beforeEach(() => {
  attachImage.mockReset();
  vi.stubGlobal('b4m', { chat: { attachImage } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function mount(sessionId: string | null) {
  await act(async () => root.render(<HookHost sessionId={sessionId} />));
}

describe('useAttachmentDraft.attachImage', () => {
  it('sends the image for the open session and appends what came back', async () => {
    attachImage.mockResolvedValue({ attachments: [ATTACHMENT], rejected: [] });
    await mount('s1');

    await act(async () => draft.attachImage(IMAGE));

    expect(attachImage).toHaveBeenCalledWith('s1', IMAGE);
    expect(draft.attachments).toEqual([ATTACHMENT]);
    expect(draft.rejected).toEqual([]);
    expect(draft.busy).toBe(false);
  });

  // A batch that lost its only file is not an error to throw; the composer shows why.
  it('keeps the rejection and stops being busy when nothing could be attached', async () => {
    attachImage.mockResolvedValue({
      attachments: [],
      rejected: [{ name: 'image', reason: 'That image is no longer available.' }],
    });
    await mount('s1');

    await act(async () => draft.attachImage(IMAGE));

    expect(draft.attachments).toEqual([]);
    expect(draft.rejected).toEqual([{ name: 'image', reason: 'That image is no longer available.' }]);
    expect(draft.busy).toBe(false);
  });

  it('does nothing without a session', async () => {
    await mount(null);

    await act(async () => draft.attachImage(IMAGE));

    expect(attachImage).not.toHaveBeenCalled();
    expect(draft.busy).toBe(false);
  });
});
