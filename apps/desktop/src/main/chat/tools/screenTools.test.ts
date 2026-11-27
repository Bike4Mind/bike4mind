import { describe, expect, it, vi } from 'vitest';
import type { ChatMedia } from '@shared/chat';
import { resolveScreenTarget, screenCapture } from './screenTools';
import type { ScreenAccess, ScreenSource, ToolContext, ToolReporter } from './types';

const SOURCES: ScreenSource[] = [
  { id: 'screen:1:0', kind: 'screen', name: 'Built-in Display' },
  { id: 'window:11:0', kind: 'window', name: 'My App - Dev' },
  { id: 'window:12:0', kind: 'window', name: 'Inbox - Mail' },
  { id: 'window:13:0', kind: 'window', name: 'My App - Settings' },
];

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function setup(access: ScreenAccess = { state: 'granted' }, options: { vision?: boolean; blank?: boolean } = {}) {
  const capture = vi.fn(async () => (options.blank ? null : PNG));
  const list = vi.fn(async () => SOURCES);
  const kept: ChatMedia = {
    kind: 'image',
    url: 'media://shot.png',
    mimeType: 'image/png',
    byteLength: PNG.length,
    caption: 'c',
  };
  const keepScreenshot = vi.fn(async () => kept);
  const images: { bytes: Buffer; mimeType: string }[] = [];
  const media: ChatMedia[] = [];
  const report = {
    image: (bytes: Buffer, mimeType: string) => images.push({ bytes, mimeType }),
    media: (item: ChatMedia) => media.push(item),
    label: () => undefined,
  } as unknown as ToolReporter;
  const context: ToolContext = {
    roots: [],
    signal: new AbortController().signal,
    screen: { capturer: { access: () => access, list, capture }, keepScreenshot },
    images: {
      vision: options.vision ?? true,
      prepare: bytes => ({
        bytes,
        mediaType: 'image/png',
        width: 800,
        height: 600,
        sourceWidth: 800,
        sourceHeight: 600,
      }),
    },
    report,
  };
  return { context, capture, list, keepScreenshot, images, media, kept };
}

describe('resolveScreenTarget', () => {
  it('takes an id, "screen", an exact title, then one partial match', () => {
    expect(resolveScreenTarget('window:12:0', SOURCES).name).toBe('Inbox - Mail');
    expect(resolveScreenTarget('screen', SOURCES).id).toBe('screen:1:0');
    expect(resolveScreenTarget('my app - dev', SOURCES).id).toBe('window:11:0');
    expect(resolveScreenTarget('inbox', SOURCES).id).toBe('window:12:0');
  });

  it('refuses a title that matches several windows, listing their ids', () => {
    expect(() => resolveScreenTarget('My App', SOURCES)).toThrow(
      /2 windows match "My App"[\s\S]*window:11:0[\s\S]*window:13:0/
    );
  });

  it('lists what is open when nothing matches', () => {
    expect(() => resolveScreenTarget('Figma', SOURCES)).toThrow(/Nothing open matches "Figma"[\s\S]*Inbox - Mail/);
  });
});

describe('screen_capture', () => {
  it('lists windows without capturing any', async () => {
    const { context, capture, images } = setup();
    const result = await screenCapture.run({}, context);
    expect(result).toContain('4 window(s) and screen(s) open:');
    expect(result).toContain('window:11:0  My App - Dev');
    expect(result).toContain('screen:1:0  screen: Built-in Display');
    expect(capture).not.toHaveBeenCalled();
    expect(images).toEqual([]);
  });

  it('captures a named window, shows it to the model and keeps it for the user', async () => {
    const { context, capture, images, media, kept, keepScreenshot } = setup();
    const result = await screenCapture.run({ target: 'inbox', caption: 'The mail window' }, context);
    expect(capture).toHaveBeenCalledWith('window:12:0', 1568);
    expect(images).toEqual([{ bytes: PNG, mimeType: 'image/png' }]);
    expect(keepScreenshot).toHaveBeenCalledWith(PNG, 'The mail window');
    expect(media).toEqual([kept]);
    expect(result).toBe(
      'Captured the window "Inbox - Mail" (800x600). You see it below this result in this reply only; capture again to look at it later.'
    );
  });

  it('shows the user a capture the model cannot see, and says so', async () => {
    const { context, images, media } = setup({ state: 'granted' }, { vision: false });
    const result = await screenCapture.run({ target: 'inbox' }, context);
    expect(images).toEqual([]);
    expect(media).toHaveLength(1);
    expect(result).toMatch(/showed it to the user, but not to you: the current model does not accept images/);
  });

  it('reports a window that came back blank', async () => {
    const { context } = setup({ state: 'granted' }, { blank: true });
    await expect(screenCapture.run({ target: 'inbox' }, context)).rejects.toThrow(/Could not capture the window/);
  });

  it('refuses before asking when Screen Recording is denied, with where to grant it', async () => {
    const message = 'Screen Recording is not allowed. Turn it on in System Settings.';
    const { context, list } = setup({ state: 'denied', message });
    await expect(Promise.resolve(screenCapture.approval?.({ target: 'inbox' }, context))).rejects.toThrow(message);
    await expect(screenCapture.run({ target: 'inbox' }, context)).rejects.toThrow(message);
    expect(list).not.toHaveBeenCalled();
  });

  it('says it is unsupported where the platform cannot capture', async () => {
    const { context } = setup({
      state: 'unsupported',
      message: 'Window capture is not supported in a Wayland session.',
    });
    await expect(screenCapture.run({}, context)).rejects.toThrow(/Wayland/);
  });

  it('tells the model to have the user allow it when macOS has only just asked', async () => {
    const { context, capture } = setup({ state: 'not-determined' });
    await expect(screenCapture.run({ target: 'inbox' }, context)).rejects.toThrow(
      /has not allowed Screen Recording[\s\S]*System Settings[\s\S]*Do not try to change the setting yourself/
    );
    expect(capture).not.toHaveBeenCalled();
  });

  it('refuses to capture a different window than the approved one', async () => {
    const { context, capture } = setup();
    const approved: ToolContext = { ...context, approvedKey: 'screen_capture\x00window:99:0' };
    await expect(screenCapture.run({ target: 'inbox' }, approved)).rejects.toThrow(/changed after the user approved/);
    expect(capture).not.toHaveBeenCalled();
    const same: ToolContext = { ...context, approvedKey: 'screen_capture\x00window:12:0' };
    await expect(screenCapture.run({ target: 'inbox' }, same)).resolves.toMatch(/Captured the window "Inbox - Mail"/);
  });

  describe('approval', () => {
    it('names the resolved window and keys on its id, asking in auto mode too', async () => {
      const { context } = setup();
      const prompt = await screenCapture.approval?.({ target: 'inbox' }, context);
      expect(prompt).toMatchObject({ key: 'screen_capture\x00window:12:0', askInAuto: true });
      expect(prompt?.detail).toContain('Capture the window "Inbox - Mail"');
      expect(prompt?.detail).toContain('goes to the model');
    });

    it('asks about listing under a key of its own', async () => {
      const { context } = setup();
      await expect(Promise.resolve(screenCapture.approval?.({}, context))).resolves.toMatchObject({
        key: 'screen_capture\x00list',
        askInAuto: true,
      });
    });

    it('does not list windows before macOS has asked for permission', async () => {
      const { context, list } = setup({ state: 'not-determined' });
      const prompt = await screenCapture.approval?.({ target: 'My App' }, context);
      expect(prompt?.detail).toMatch(/macOS asks for Screen Recording permission first/);
      expect(list).not.toHaveBeenCalled();
    });

    it('refuses an ambiguous target without asking', async () => {
      const { context } = setup();
      await expect(Promise.resolve(screenCapture.approval?.({ target: 'My App' }, context))).rejects.toThrow(
        /2 windows match/
      );
    });
  });
});
