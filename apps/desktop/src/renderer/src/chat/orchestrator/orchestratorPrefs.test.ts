// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ORCHESTRATOR_VIEWS,
  readDockOpen,
  readIntroSeen,
  readSurface,
  readView,
  writeDockOpen,
  writeIntroSeen,
  writeSurface,
  writeView,
} from './orchestratorPrefs';

describe('orchestratorPrefs', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('lists the three views', () => {
    expect(ORCHESTRATOR_VIEWS).toEqual(['tavern', 'board', 'table']);
  });

  it('defaults when nothing is stored', () => {
    expect(readSurface('s1')).toBe('chat');
    expect(readView('s1')).toBe('tavern');
    expect(readDockOpen()).toBe(true);
    expect(readIntroSeen()).toBe(false);
  });

  it('round-trips each preference, keyed per session', () => {
    writeSurface('s1', 'orchestrate');
    writeView('s1', 'board');
    writeDockOpen(false);
    writeIntroSeen();
    expect(readSurface('s1')).toBe('orchestrate');
    expect(readSurface('s2')).toBe('chat');
    expect(readView('s1')).toBe('board');
    expect(readView('s2')).toBe('tavern');
    expect(readDockOpen()).toBe(false);
    expect(readIntroSeen()).toBe(true);
    expect(window.localStorage.getItem('b4m.orchestrator.surface.s1')).toBe('orchestrate');
    expect(window.localStorage.getItem('b4m.orchestrator.view.s1')).toBe('board');
  });

  it('falls back to the default for an unknown stored value', () => {
    window.localStorage.setItem('b4m.orchestrator.view.s1', 'bogus');
    window.localStorage.setItem('b4m.orchestrator.surface.s1', 'bogus');
    expect(readView('s1')).toBe('tavern');
    expect(readSurface('s1')).toBe('chat');
  });

  it('yields defaults and does not throw when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readSurface('s1')).toBe('chat');
    expect(readView('s1')).toBe('tavern');
    expect(readDockOpen()).toBe(true);
    expect(readIntroSeen()).toBe(false);
    expect(() => {
      writeSurface('s1', 'orchestrate');
      writeView('s1', 'table');
      writeDockOpen(false);
      writeIntroSeen();
    }).not.toThrow();
  });
});
