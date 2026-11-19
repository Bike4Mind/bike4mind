// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { markSessionViewed } from './markSessionViewed';

afterEach(() => vi.restoreAllMocks());

it.each([
  ['visible', true, true],
  ['visible', false, false],
  ['hidden', true, false],
] as const)('acknowledges only visible focused opens: %s/%s', async (visibility, focused, expected) => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(visibility);
  vi.spyOn(document, 'hasFocus').mockReturnValue(focused);
  const getSession = vi.fn().mockResolvedValue(null);
  window.b4m = { chat: { getSession } } as unknown as typeof window.b4m;
  markSessionViewed('child');
  await Promise.resolve();
  expect(getSession).toHaveBeenCalledTimes(expected ? 1 : 0);
  if (expected) expect(getSession).toHaveBeenCalledWith('child', true);
});

it('logs acknowledgement failures', async () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  const error = new Error('IPC failed');
  window.b4m = { chat: { getSession: vi.fn().mockRejectedValue(error) } } as unknown as typeof window.b4m;
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  markSessionViewed('child');
  await Promise.resolve();
  expect(warn).toHaveBeenCalledWith('Could not acknowledge viewed session', error);
});
