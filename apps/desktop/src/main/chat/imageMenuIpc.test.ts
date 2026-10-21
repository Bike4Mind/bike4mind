import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, sep } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddAttachmentsResult, ChatImageActionResult, ChatImageRef } from '@shared/chat';
import { IPC_CHANNELS } from '@shared/ipc';
import { AttachmentStore } from './AttachmentStore';
import { markdownImage, registerImageMenuIpc } from './imageMenuIpc';
import { MediaStore } from './media/MediaStore';

const SESSION = 'session-1';
// A real PNG header is not needed: nothing here decodes, and copyImage is a fake.
const PNG = Buffer.from('not really a png');

async function setup(directoryName = '') {
  const base = join(await mkdtemp(join(tmpdir(), 'b4m-image-menu-')), directoryName);
  const media = new MediaStore(join(base, 'media'));
  const attachments = new AttachmentStore(join(base, 'attachments'), { debug: () => {}, warn: () => {} });
  const deps = {
    media,
    attachments,
    readFile: vi.fn((path: string) => readFile(path)),
    copyImage: vi.fn(async (_bytes: Buffer) => true),
    copyText: vi.fn(async (_text: string) => {}),
    pickSavePath: vi.fn(async (_sender: unknown, _options: unknown): Promise<string | null> => null),
    copyFile: vi.fn(async (_from: string, _to: string) => {}),
    reveal: vi.fn((_path: string) => {}),
    downloadsDirectory: () => join(base, 'Downloads'),
    now: () => new Date(2026, 9, 21, 14, 30, 5),
  };
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerImageMenuIpc(
    {
      handle: (channel: string, listener: (...args: never[]) => unknown) =>
        void handlers.set(channel, listener as never),
    },
    deps
  );
  const event = { sender: {} };
  const act = (image: unknown, action: unknown) =>
    handlers.get(IPC_CHANNELS.chatImageAction)!(event, image, action) as Promise<ChatImageActionResult>;
  const attach = (sessionId: unknown, image: unknown) =>
    handlers.get(IPC_CHANNELS.chatAttachImage)!(event, sessionId, image) as Promise<AddAttachmentsResult>;

  const screenshot = await media.save(SESSION, PNG, 'image/png');
  const added = await attachments.add(SESSION, [
    { source: 'bytes', name: 'pasted.png', mediaType: 'image/png', data: PNG },
  ]);
  const attachment = added.attachments[0];
  const mediaRef: ChatImageRef = { source: 'media', url: screenshot.url, nameHint: 'screenshot' };
  const attachmentRef: ChatImageRef = {
    source: 'attachment',
    sessionId: SESSION,
    attachmentId: attachment.id,
    mediaType: 'image/png',
    name: attachment.name,
  };

  const touchedNothing = () => {
    expect(deps.copyImage).not.toHaveBeenCalled();
    expect(deps.copyText).not.toHaveBeenCalled();
    expect(deps.pickSavePath).not.toHaveBeenCalled();
    expect(deps.copyFile).not.toHaveBeenCalled();
    expect(deps.reveal).not.toHaveBeenCalled();
  };

  return { base, media, deps, act, attach, mediaRef, attachmentRef, screenshot, attachment, touchedNothing };
}

describe('image menu IPC', () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    s = await setup();
  });

  describe('validation', () => {
    it.each([
      ['a file URL', { source: 'media', url: 'file:///etc/passwd' }],
      ['a raw path', { source: 'media', url: '/etc/passwd' }],
      ['a traversal in a media URL', { source: 'media', url: 'b4m-media://media/../../etc/passwd' }],
      [
        'a media URL naming a file the store never wrote',
        { source: 'media', url: 'b4m-media://media/session-1/passwd' },
      ],
      [
        'an unknown uuid',
        { source: 'media', url: 'b4m-media://media/session-1/00000000-0000-0000-0000-000000000000.png' },
      ],
      [
        'a traversal as an attachment id',
        {
          source: 'attachment',
          sessionId: SESSION,
          attachmentId: '../../etc/passwd',
          mediaType: 'image/png',
          name: 'x',
        },
      ],
      [
        'a traversal as a session id',
        { source: 'attachment', sessionId: '..', attachmentId: 'a', mediaType: 'image/png', name: 'x' },
      ],
      ['a malformed escape in a media URL', { source: 'media', url: 'b4m-media://media/session-1/%E0.png' }],
      ['a path field the ref does not have', { source: 'path', path: '/etc/passwd' }],
      ['a non-object', '/etc/passwd'],
      ['null', null],
    ])('refuses %s and touches nothing', async (_label, ref) => {
      for (const action of ['copy', 'save', 'copy-path', 'copy-markdown', 'reveal']) {
        expect(await s.act(ref, action)).toEqual({ ok: false, error: expect.any(String) });
      }
      s.touchedNothing();
    });

    it('refuses an attachment whose media type is not an image', async () => {
      const ref = { ...s.attachmentRef, mediaType: 'text/html' };
      expect(await s.act(ref, 'copy-path')).toMatchObject({ ok: false });
      s.touchedNothing();
    });

    it('refuses a stored file that is not an image', async () => {
      const audio = await s.media.save(SESSION, PNG, 'audio/mpeg');
      expect(await s.act({ source: 'media', url: audio.url }, 'reveal')).toMatchObject({ ok: false });
      s.touchedNothing();
    });

    it('refuses an unknown action', async () => {
      expect(await s.act(s.mediaRef, 'delete')).toMatchObject({ ok: false });
      s.touchedNothing();
    });

    it('allows a remote image only its Markdown, and only over http(s)', async () => {
      expect(await s.act({ source: 'remote', url: 'https://example.com/a b.png' }, 'copy-markdown')).toEqual({
        ok: true,
        done: true,
      });
      expect(s.deps.copyText).toHaveBeenCalledWith('![](https://example.com/a%20b.png)');

      expect(await s.act({ source: 'remote', url: 'https://example.com/a.png' }, 'save')).toMatchObject({ ok: false });
      expect(await s.act({ source: 'remote', url: 'javascript:alert(1)' }, 'copy-markdown')).toMatchObject({
        ok: false,
      });
      expect(s.deps.copyText).toHaveBeenCalledTimes(1);
      expect(s.deps.pickSavePath).not.toHaveBeenCalled();
    });
  });

  describe('save', () => {
    it('is a no-op when the dialog is cancelled', async () => {
      expect(await s.act(s.mediaRef, 'save')).toEqual({ ok: true, done: false });
      expect(s.deps.pickSavePath).toHaveBeenCalledTimes(1);
      expect(s.deps.copyFile).not.toHaveBeenCalled();
    });

    it('offers a dated name with the original extension, then copies the stored bytes', async () => {
      s.deps.pickSavePath.mockResolvedValueOnce('/chosen/shot.png');
      expect(await s.act(s.mediaRef, 'save')).toEqual({ ok: true, done: true });

      expect(s.deps.pickSavePath).toHaveBeenCalledWith(expect.anything(), {
        defaultPath: join(s.base, 'Downloads', 'screenshot-2026-10-21-143005.png'),
        filters: [{ name: 'Image', extensions: ['png'] }],
      });
      const [from, to] = s.deps.copyFile.mock.calls[0];
      expect(from.startsWith(join(s.base, 'media', SESSION) + sep)).toBe(true);
      expect(to).toBe('/chosen/shot.png');
    });

    it('names an attachment after itself', async () => {
      await s.act(s.attachmentRef, 'save');
      expect(s.deps.pickSavePath.mock.calls[0][1]).toMatchObject({
        defaultPath: join(s.base, 'Downloads', 'pasted.png'),
      });
    });

    it('reports a failed copy instead of throwing', async () => {
      s.deps.pickSavePath.mockResolvedValueOnce('/chosen/shot.png');
      s.deps.copyFile.mockRejectedValueOnce(new Error('EACCES: permission denied'));
      expect(await s.act(s.mediaRef, 'save')).toEqual({ ok: false, error: 'EACCES: permission denied' });
    });
  });

  describe('the other actions', () => {
    it('copies, reveals and names only files inside the app stores', async () => {
      await s.act(s.mediaRef, 'copy');
      await s.act(s.attachmentRef, 'copy-path');
      await s.act(s.mediaRef, 'reveal');

      expect(s.deps.copyImage).toHaveBeenCalledWith(PNG);
      expect(s.deps.copyText.mock.calls[0][0].startsWith(join(s.base, 'attachments', SESSION) + sep)).toBe(true);
      expect(s.deps.reveal.mock.calls[0][0].startsWith(join(s.base, 'media', SESSION) + sep)).toBe(true);
    });

    it('says so when the clipboard cannot take the image', async () => {
      s.deps.copyImage.mockResolvedValueOnce(false);
      expect(await s.act(s.mediaRef, 'copy')).toMatchObject({ ok: false });
    });

    it('copies an image on disk as Markdown pointing at its stored file', async () => {
      expect(await s.act(s.mediaRef, 'copy-markdown')).toEqual({ ok: true, done: true });
      expect(await s.act(s.attachmentRef, 'copy-markdown')).toEqual({ ok: true, done: true });

      const mediaFile = await s.media.locate(SESSION, s.screenshot.name);
      expect(s.deps.copyText.mock.calls[0][0]).toBe(markdownImage(pathToFileURL(mediaFile!.path).href));
      expect(s.deps.copyText.mock.calls[1][0]).toBe(
        markdownImage(pathToFileURL(join(s.base, 'attachments', SESSION, s.attachment.id)).href)
      );
    });
  });

  it.each(['A#B', 'A%B', 'A%20B', 'A B', 'A(1)', ...(process.platform === 'win32' ? [] : ['A?B', 'A\\B', 'A<B>'])])(
    'copies Markdown with the exact stored path under %s',
    async directoryName => {
      const special = await setup(directoryName);
      for (const ref of [special.mediaRef, special.attachmentRef]) {
        expect(await special.act(ref, 'copy-path')).toEqual({ ok: true, done: true });
        const [storedPath] = special.deps.copyText.mock.calls.at(-1)!;
        expect(await special.act(ref, 'copy-markdown')).toEqual({ ok: true, done: true });
        const [markdown] = special.deps.copyText.mock.calls.at(-1)!;
        // Parentheses use CommonMark's angle-bracket destination syntax.
        const markdownDestination = markdown.slice(4, -1);
        const destination = markdownDestination.startsWith('<')
          ? markdownDestination.slice(1, -1)
          : markdownDestination;
        const url = new URL(destination);
        expect(url.protocol).toBe('file:');
        expect(url.search).toBe('');
        expect(url.hash).toBe('');
        expect(fileURLToPath(url)).toBe(storedPath);
      }
    }
  );

  describe('attach', () => {
    it('adds the stored image to the session through the attachment intake', async () => {
      const result = await s.attach(SESSION, s.mediaRef);
      expect(result.rejected).toEqual([]);
      expect(result.attachments).toHaveLength(1);
      expect(result.attachments[0]).toMatchObject({
        kind: 'image',
        mediaType: 'image/png',
        name: 'screenshot-2026-10-21-143005.png',
      });
    });

    it('copies an attachment into the target session independently of its original', async () => {
      const targetSession = 'target-session';
      const result = await s.attach(targetSession, s.attachmentRef);
      expect(result.rejected).toEqual([]);
      expect(result.attachments).toHaveLength(1);
      const [copied] = result.attachments;
      expect(copied).toMatchObject({ kind: 'image', mediaType: 'image/png', name: 'pasted.png' });
      expect(await s.deps.attachments.read(targetSession, copied.id)).toEqual(PNG);
      await s.deps.attachments.discard(SESSION, s.attachment.id);
      expect(await s.deps.attachments.read(SESSION, s.attachment.id)).toBeNull();
      expect(await s.deps.attachments.read(targetSession, copied.id)).toEqual(PNG);
    });

    it('rejects a bad session id or an unresolvable ref without writing', async () => {
      for (const [sessionId, ref] of [
        ['../x', s.mediaRef],
        [SESSION, { source: 'remote', url: 'https://example.com/a.png' }],
        [SESSION, { source: 'media', url: 'file:///etc/passwd' }],
      ] as const) {
        const result = await s.attach(sessionId, ref);
        expect(result.attachments).toEqual([]);
        expect(result.rejected).toHaveLength(1);
      }
      expect(s.deps.readFile).not.toHaveBeenCalled();
    });

    it('answers a failed read with a rejected batch instead of throwing', async () => {
      s.deps.readFile.mockRejectedValueOnce(new Error('ENOENT: no such file or directory'));

      const result = await s.attach(SESSION, s.mediaRef);

      expect(result.attachments).toEqual([]);
      expect(result.rejected).toEqual([{ name: 'image', reason: expect.stringContaining('could not be attached') }]);
    });

    it('answers a failed write the same way', async () => {
      const add = vi.spyOn(s.deps.attachments, 'add').mockRejectedValueOnce(new Error('ENOSPC: no space left'));

      const result = await s.attach(SESSION, s.mediaRef);

      add.mockRestore();
      expect(result.rejected).toEqual([{ name: 'image', reason: expect.stringContaining('could not be attached') }]);
    });
  });
});

describe('markdownImage', () => {
  it('wraps a destination with spaces in angle brackets', () => {
    expect(markdownImage('/Users/me/Library/Application Support/app/x.png')).toBe(
      '![](</Users/me/Library/Application Support/app/x.png>)'
    );
    expect(markdownImage('/tmp/x.png')).toBe('![](/tmp/x.png)');
  });

  // A bare `\` before the closing paren escapes it, leaving the link unclosed.
  it('escapes a backslash in a bare destination', () => {
    expect(markdownImage('https://x.com/a.png?q=\\')).toBe('![](https://x.com/a.png?q=\\\\)');
  });

  it('escapes angle brackets in a bare destination', () => {
    expect(markdownImage('/tmp/a<b>.png')).toBe('![](/tmp/a\\<b\\>.png)');
  });

  it.each([
    ['/tmp/a<b> (1).png', '![](</tmp/a\\<b\\> (1).png>)'],
    ['/tmp/a\\(1).png', '![](</tmp/a\\\\(1).png>)'],
    ['C:\\Users\\me\\My Pictures\\image.png', '![](<C:\\\\Users\\\\me\\\\My Pictures\\\\image.png>)'],
  ])('escapes special characters inside the bracketed destination %s', (destination, expected) => {
    expect(markdownImage(destination)).toBe(expected);
  });

  it.each([
    ['/tmp/a\nb.png', '![](</tmp/a%0Ab.png>)'],
    ['/tmp/a\rb.png', '![](</tmp/a%0Db.png>)'],
    ['/tmp/a\r\nb.png', '![](</tmp/a%0D%0Ab.png>)'],
  ])('encodes line endings in the destination %s', (destination, expected) => {
    expect(markdownImage(destination)).toBe(expected);
  });
});
