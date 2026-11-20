import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({ all: [] as object[], focused: null as object | null }));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => electron.all,
    getFocusedWindow: () => electron.focused,
  },
}));

const { appWindows, focusedAppWindow, markAgentBrowserWindow, markCompanionWindow, markDeveloperWindow } =
  await import('./windows');

type Window = Parameters<typeof markAgentBrowserWindow>[0];

describe('focusedAppWindow', () => {
  const chat = {} as Window;
  const second = {} as Window;
  const devLog = {} as Window;
  const agentBrowser = {} as Window;
  const miniTavern = {} as Window;

  beforeEach(() => {
    markDeveloperWindow(devLog);
    markAgentBrowserWindow(agentBrowser);
    markCompanionWindow(miniTavern);
    electron.all = [chat, second, devLog, agentBrowser, miniTavern];
  });

  it('leaves the mini Tavern out of the app windows', () => {
    expect(appWindows()).toEqual([chat, second]);
  });

  it('picks the focused app window', () => {
    electron.focused = second;
    expect(focusedAppWindow()).toBe(second);
  });

  it.each([
    ['the developer log', devLog],
    ['an agent browser', agentBrowser],
    ['the mini Tavern', miniTavern],
    ['nothing', null],
  ])('falls back to the first app window when %s has focus', (_label, focused) => {
    electron.focused = focused;
    expect(focusedAppWindow()).toBe(chat);
  });

  it('returns nothing when no app window is open', () => {
    electron.all = [devLog];
    electron.focused = devLog;
    expect(focusedAppWindow()).toBeUndefined();
  });
});
