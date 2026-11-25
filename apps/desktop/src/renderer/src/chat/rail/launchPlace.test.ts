// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  launchPlace,
  parseStoredLaunchPlace,
  pickFirstLaunchPlace,
  reloadLaunchPlaceForTest,
  resolveLaunch,
  setLaunchPlace,
} from './launchPlace';

afterEach(() => {
  window.localStorage.clear();
  reloadLaunchPlaceForTest();
  vi.restoreAllMocks();
});

describe('resolveLaunch with Last used', () => {
  it('reopens the last place and its session', () => {
    expect(
      resolveLaunch({
        preference: 'last',
        memory: { place: 'code', chat: 'c1', code: 'k1' },
        lastSession: { id: 'k1', mode: 'code' },
      })
    ).toEqual({ place: 'code', mode: 'code', session: { id: 'k1', mode: 'code' }, firstLaunch: false });
  });

  it('does not let a chat reopened underneath drag a Code launch back to Chat', () => {
    // The user switched to an empty Code place after their last chat: Code stays, with no session.
    expect(
      resolveLaunch({
        preference: 'last',
        memory: { place: 'code', chat: 'c1' },
        lastSession: { id: 'c1', mode: 'chat' },
      })
    ).toEqual({ place: 'code', mode: 'code', session: null, firstLaunch: false });
  });

  it('reopens Studio with the conversation that was open underneath', () => {
    expect(
      resolveLaunch({
        preference: 'last',
        memory: { place: 'studio', code: 'k1', studio: 'create' },
        lastSession: { id: 'k1', mode: 'code' },
      })
    ).toEqual({ place: 'studio', mode: 'code', session: { id: 'k1', mode: 'code' }, firstLaunch: false });
  });

  it('falls back to the last session when only that was remembered (before the rail)', () => {
    expect(resolveLaunch({ preference: 'last', memory: null, lastSession: { id: 'k1', mode: 'code' } })).toEqual({
      place: 'code',
      mode: 'code',
      session: { id: 'k1', mode: 'code' },
      firstLaunch: false,
    });
  });

  it('flags a first launch when nothing is remembered', () => {
    expect(resolveLaunch({ preference: 'last', memory: null, lastSession: null })).toEqual({
      place: 'chat',
      mode: 'chat',
      session: null,
      firstLaunch: true,
    });
  });
});

describe('resolveLaunch with a pinned place', () => {
  it('opens the pinned session place on its own last session, not the last one overall', () => {
    expect(
      resolveLaunch({
        preference: 'code',
        memory: { place: 'chat', chat: 'c1', code: 'k1' },
        lastSession: { id: 'c1', mode: 'chat' },
      })
    ).toEqual({ place: 'code', mode: 'code', session: { id: 'k1', mode: 'code' }, firstLaunch: false });
  });

  it('opens the pinned place empty when it has never had a session', () => {
    expect(
      resolveLaunch({
        preference: 'code',
        memory: { place: 'chat', chat: 'c1' },
        lastSession: { id: 'c1', mode: 'chat' },
      })
    ).toEqual({ place: 'code', mode: 'code', session: null, firstLaunch: false });
  });

  it('opens Studio over the remembered conversation', () => {
    expect(
      resolveLaunch({
        preference: 'studio',
        memory: { place: 'chat', chat: 'c1' },
        lastSession: { id: 'c1', mode: 'chat' },
      })
    ).toEqual({ place: 'studio', mode: 'chat', session: { id: 'c1', mode: 'chat' }, firstLaunch: false });
  });

  it('never runs the first-launch pick: the user already chose', () => {
    expect(resolveLaunch({ preference: 'chat', memory: null, lastSession: null }).firstLaunch).toBe(false);
    expect(resolveLaunch({ preference: 'studio', memory: null, lastSession: null })).toEqual({
      place: 'studio',
      mode: 'chat',
      session: null,
      firstLaunch: false,
    });
  });
});

describe('pickFirstLaunchPlace', () => {
  it('opens Code for a Claude Code user or a recent repository, Chat otherwise', () => {
    expect(pickFirstLaunchPlace({ claudeCode: true, recentRepository: false })).toBe('code');
    expect(pickFirstLaunchPlace({ claudeCode: false, recentRepository: true })).toBe('code');
    expect(pickFirstLaunchPlace({ claudeCode: false, recentRepository: false })).toBe('chat');
  });
});

describe('the Open on launch preference', () => {
  it('defaults to Last used, including for values it does not know', () => {
    expect(launchPlace()).toBe('last');
    expect(parseStoredLaunchPlace(null)).toBe('last');
    expect(parseStoredLaunchPlace('agents')).toBe('last');
    expect(parseStoredLaunchPlace('code')).toBe('code');
  });

  it('persists across a reload', () => {
    setLaunchPlace('studio');
    expect(window.localStorage.getItem('b4m.chat.launchPlace')).toBe('studio');
    reloadLaunchPlaceForTest();
    expect(launchPlace()).toBe('studio');
  });

  it('keeps the choice for this run when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    setLaunchPlace('code');
    expect(launchPlace()).toBe('code');
  });
});
