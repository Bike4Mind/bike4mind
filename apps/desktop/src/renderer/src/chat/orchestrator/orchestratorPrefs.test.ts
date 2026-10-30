// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ORCHESTRATOR_VIEWS,
  pruneSessionPrefs,
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

  it('prunes per-session keys for sessions no longer listed, and nothing else', () => {
    writeSurface('kept', 'orchestrate');
    writeView('kept', 'board');
    writeSurface('gone', 'orchestrate');
    writeView('gone', 'table');
    writeDockOpen(false);
    writeIntroSeen();
    window.localStorage.setItem('unrelated.key.gone', 'x');

    pruneSessionPrefs(new Set(['kept']));

    expect(readSurface('kept')).toBe('orchestrate');
    expect(readView('kept')).toBe('board');
    expect(window.localStorage.getItem('b4m.orchestrator.surface.gone')).toBeNull();
    expect(window.localStorage.getItem('b4m.orchestrator.view.gone')).toBeNull();
    expect(readDockOpen()).toBe(false);
    expect(readIntroSeen()).toBe(true);
    expect(window.localStorage.getItem('unrelated.key.gone')).toBe('x');
  });

  it('does not throw when storage throws while pruning', () => {
    vi.spyOn(Storage.prototype, 'key').mockImplementation(() => {
      throw new Error('blocked');
    });
    window.localStorage.setItem('b4m.orchestrator.view.gone', 'table');
    expect(() => pruneSessionPrefs(new Set())).not.toThrow();
  });
});
