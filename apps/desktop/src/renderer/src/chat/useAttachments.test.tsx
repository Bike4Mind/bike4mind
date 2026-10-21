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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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

describe('attachment draft lifetime', () => {
  it('ignores results and rejections from the previous session without clearing the new busy state', async () => {
    const previous = deferred<AddAttachmentsResult>();
    const current = deferred<AddAttachmentsResult>();
    attachImage.mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise);
    await mount('s1');
    let previousIntake: Promise<void>;
    act(() => {
      previousIntake = draft.attachImage(IMAGE);
    });
    expect(draft.busy).toBe(true);

    await mount('s2');
    expect(draft.busy).toBe(false);
    let currentIntake: Promise<void>;
    act(() => {
      currentIntake = draft.attachImage(IMAGE);
    });
    await act(async () => {
      previous.resolve({ attachments: [ATTACHMENT], rejected: [{ name: 'old', reason: 'old rejection' }] });
      await previousIntake;
    });
    expect(draft.attachments).toEqual([]);
    expect(draft.rejected).toEqual([]);
    expect(draft.busy).toBe(true);

    await act(async () => {
      current.resolve({ attachments: [ATTACHMENT], rejected: [] });
      await currentIntake;
    });
    expect(draft.attachments).toEqual([ATTACHMENT]);
    expect(draft.busy).toBe(false);
  });

  it('does not restore an abandoned draft after switching away and back', async () => {
    const previous = deferred<AddAttachmentsResult>();
    attachImage.mockReturnValueOnce(previous.promise);
    await mount('s1');
    let intake: Promise<void>;
    act(() => {
      intake = draft.attachImage(IMAGE);
    });
    await mount('s2');
    await mount('s1');

    await act(async () => {
      previous.resolve({ attachments: [ATTACHMENT], rejected: [] });
      await intake;
    });
    expect(draft.attachments).toEqual([]);
    expect(draft.busy).toBe(false);
  });

  it('ignores a captured callback from a session that has been left', async () => {
    attachImage.mockResolvedValue({ attachments: [], rejected: [] });
    await mount('s1');
    const previousAttach = draft.attachImage;
    await mount('s2');
    await mount('s1');

    await act(async () => previousAttach(IMAGE));

    expect(attachImage).not.toHaveBeenCalled();
    expect(draft.busy).toBe(false);
  });

  it('stays busy until every concurrent intake has finished', async () => {
    const first = deferred<AddAttachmentsResult>();
    const second = deferred<AddAttachmentsResult>();
    attachImage.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await mount('s1');
    let firstIntake: Promise<void>;
    let secondIntake: Promise<void>;
    act(() => {
      firstIntake = draft.attachImage(IMAGE);
      secondIntake = draft.attachImage(IMAGE);
    });
    const secondAttachment = { ...ATTACHMENT, id: 'a2' };
    await act(async () => {
      second.resolve({ attachments: [secondAttachment], rejected: [] });
      await secondIntake;
    });
    expect(draft.attachments).toEqual([secondAttachment]);
    expect(draft.busy).toBe(true);

    await act(async () => {
      first.resolve({ attachments: [ATTACHMENT], rejected: [] });
      await firstIntake;
    });
    expect(draft.attachments).toEqual([secondAttachment, ATTACHMENT]);
    expect(draft.busy).toBe(false);
  });

  it('invalidates pending results when the draft is cleared', async () => {
    const previous = deferred<AddAttachmentsResult>();
    const current = deferred<AddAttachmentsResult>();
    attachImage.mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise);
    await mount('s1');
    let previousIntake: Promise<void>;
    act(() => {
      previousIntake = draft.attachImage(IMAGE);
    });
    act(() => draft.clear());
    expect(draft.busy).toBe(false);
    let currentIntake: Promise<void>;
    act(() => {
      currentIntake = draft.attachImage(IMAGE);
    });

    await act(async () => {
      previous.resolve({ attachments: [ATTACHMENT], rejected: [{ name: 'old', reason: 'old rejection' }] });
      await previousIntake;
    });
    expect(draft.attachments).toEqual([]);
    expect(draft.rejected).toEqual([]);
    expect(draft.busy).toBe(true);

    await act(async () => {
      current.resolve({ attachments: [ATTACHMENT], rejected: [] });
      await currentIntake;
    });
    expect(draft.attachments).toEqual([ATTACHMENT]);
    expect(draft.busy).toBe(false);
  });

  it('keeps other current requests busy when one intake throws', async () => {
    const first = deferred<AddAttachmentsResult>();
    const second = deferred<AddAttachmentsResult>();
    attachImage.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await mount('s1');
    let firstIntake: Promise<void>;
    let secondIntake: Promise<void>;
    act(() => {
      firstIntake = draft.attachImage(IMAGE);
      secondIntake = draft.attachImage(IMAGE);
    });
    await act(async () => {
      const failure = expect(firstIntake).rejects.toThrow('read failed');
      first.reject(new Error('read failed'));
      await failure;
    });
    expect(draft.busy).toBe(true);

    await act(async () => {
      second.resolve({ attachments: [ATTACHMENT], rejected: [] });
      await secondIntake;
    });
    expect(draft.attachments).toEqual([ATTACHMENT]);
    expect(draft.busy).toBe(false);
  });
});
