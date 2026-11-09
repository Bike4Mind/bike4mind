// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DOCK_DEFAULT_WIDTH,
  DOCK_MIN_WIDTH,
  ORCHESTRATOR_VIEWS,
  clampDockWidth,
  dockMaxWidth,
  readDockWidth,
  writeDockWidth,
  forgetSessionPrefs,
  readAmbient,
  readAmbientHintSeen,
  readDockOpen,
  readFinaleSeen,
  readIntroSeen,
  readSurface,
  readView,
  writeAmbient,
  writeAmbientHintSeen,
  writeDockOpen,
  writeFinaleSeen,
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

  it('remembers the last celebrated run per session', () => {
    expect(readFinaleSeen('s1')).toBeNull();
    writeFinaleSeen('s1', 'run-a');
    expect(readFinaleSeen('s1')).toBe('run-a');
    expect(readFinaleSeen('s2')).toBeNull();
    writeFinaleSeen('s1', 'run-b');
    expect(readFinaleSeen('s1')).toBe('run-b');
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

  it('forgets one session surface and view, and nothing else', () => {
    writeSurface('gone', 'orchestrate');
    writeView('gone', 'table');
    writeFinaleSeen('gone', 'run');
    writeSurface('kept', 'orchestrate');
    writeDockOpen(false);

    forgetSessionPrefs('gone');

    expect(window.localStorage.getItem('b4m.orchestrator.surface.gone')).toBeNull();
    expect(window.localStorage.getItem('b4m.orchestrator.view.gone')).toBeNull();
    expect(readFinaleSeen('gone')).toBeNull();
    expect(readSurface('kept')).toBe('orchestrate');
    expect(readDockOpen()).toBe(false);
  });

  it('does not throw when storage throws while forgetting', () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => forgetSessionPrefs('gone')).not.toThrow();
  });

  it('keeps the ambient Tavern on until turned off, and its hint shown once', () => {
    expect(readAmbient()).toBe(true);
    writeAmbient(false);
    expect(readAmbient()).toBe(false);
    writeAmbient(true);
    expect(readAmbient()).toBe(true);

    expect(readAmbientHintSeen()).toBe(false);
    writeAmbientHintSeen();
    expect(readAmbientHintSeen()).toBe(true);
  });

  describe('dock width', () => {
    it('defaults to 380px and keeps at least 300px', () => {
      expect(readDockWidth()).toBe(DOCK_DEFAULT_WIDTH);
      expect(DOCK_DEFAULT_WIDTH).toBe(380);
      expect(clampDockWidth(120)).toBe(DOCK_MIN_WIDTH);
      expect(clampDockWidth(512.6)).toBe(513);
      expect(clampDockWidth(Number.NaN)).toBe(DOCK_DEFAULT_WIDTH);
    });

    it('caps the dock at half the window, letting the cap win in a tiny window', () => {
      expect(dockMaxWidth(1441)).toBe(720);
      expect(clampDockWidth(900, dockMaxWidth(1440))).toBe(720);
      expect(clampDockWidth(400, dockMaxWidth(1440))).toBe(400);
      expect(clampDockWidth(400, dockMaxWidth(500))).toBe(250);
    });

    it('round-trips a width, clamped only to the minimum on the way back in', () => {
      writeDockWidth(640);
      expect(window.localStorage.getItem('b4m.orchestrator.dockWidth')).toBe('640');
      expect(readDockWidth()).toBe(640);
      window.localStorage.setItem('b4m.orchestrator.dockWidth', '2000');
      expect(readDockWidth()).toBe(2000);
      window.localStorage.setItem('b4m.orchestrator.dockWidth', '10');
      expect(readDockWidth()).toBe(DOCK_MIN_WIDTH);
      window.localStorage.setItem('b4m.orchestrator.dockWidth', 'wide');
      expect(readDockWidth()).toBe(DOCK_DEFAULT_WIDTH);
    });

    it('falls back to the default and does not throw when storage throws', () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      expect(readDockWidth()).toBe(DOCK_DEFAULT_WIDTH);
      expect(() => writeDockWidth(500)).not.toThrow();
    });
  });
});
