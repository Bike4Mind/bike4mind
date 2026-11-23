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
  readLayout,
  readPresenter,
  readSurface,
  readView,
  writeAmbient,
  writePresenter,
  writeAmbientHintSeen,
  writeDockOpen,
  writeFinaleSeen,
  writeIntroSeen,
  writeLayout,
  writeSurface,
  writeView,
} from './orchestratorPrefs';
import { singlePaneLayout, type OrchestratorLayout } from './orchestratorLayout';

describe('orchestratorPrefs', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('lists the scenes, then the layouts', () => {
    expect(ORCHESTRATOR_VIEWS).toEqual([
      'tavern',
      'aquarium',
      'office',
      'board',
      'table',
      'plan',
      'tile-wall',
      'swimlanes',
      'constellation',
      'transit',
    ]);
  });

  it('remembers each session its own view', () => {
    writeView('s1', 'tile-wall');
    writeView('s2', 'aquarium');
    expect(readView('s1')).toBe('tile-wall');
    expect(readView('s2')).toBe('aquarium');
  });

  it('remembers Office at the session, project and global levels', () => {
    writeView('office-session', 'office', '/office-project');
    writeView('other-session', 'board', '/other-project');
    expect(readView('office-session', '/other-project')).toBe('office');
    expect(readView('new-session', '/office-project')).toBe('office');
    writeView('office-session', 'office', '/office-project');
    expect(readView('new-session', '/new-project')).toBe('office');
  });

  describe('view fallback levels', () => {
    const VIEW = 'b4m.orchestrator.view.';
    const PROJECT = 'b4m.orchestrator.projectView.';
    const LAST = 'b4m.orchestrator.lastView';

    it('prefers the session, then its project, then the global last choice, then the Tavern', () => {
      expect(readView('s1', '/p')).toBe('tavern');
      window.localStorage.setItem(LAST, 'table');
      expect(readView('s1', '/p')).toBe('table');
      window.localStorage.setItem(PROJECT + '/p', 'board');
      expect(readView('s1', '/p')).toBe('board');
      window.localStorage.setItem(VIEW + 's1', 'aquarium');
      expect(readView('s1', '/p')).toBe('aquarium');
    });

    it('skips the project level for a session without a project', () => {
      window.localStorage.setItem(PROJECT + '/p', 'board');
      window.localStorage.setItem(LAST, 'table');
      expect(readView('s1')).toBe('table');
      expect(readView('s1', '')).toBe('table');
    });

    it("does not use another project's choice", () => {
      window.localStorage.setItem(PROJECT + '/p', 'board');
      expect(readView('s1', '/other')).toBe('tavern');
    });

    it('falls through an unknown id at every level', () => {
      window.localStorage.setItem(VIEW + 's1', 'koi-pond');
      window.localStorage.setItem(PROJECT + '/p', 'koi-pond');
      window.localStorage.setItem(LAST, 'koi-pond');
      expect(readView('s1', '/p')).toBe('tavern');
      window.localStorage.setItem(LAST, 'table');
      expect(readView('s1', '/p')).toBe('table');
      window.localStorage.setItem(PROJECT + '/p', 'board');
      expect(readView('s1', '/p')).toBe('board');
    });

    it('writeView records the session, its project and the global choice', () => {
      writeView('s1', 'board', '/p');
      expect(window.localStorage.getItem(VIEW + 's1')).toBe('board');
      expect(window.localStorage.getItem(PROJECT + '/p')).toBe('board');
      expect(window.localStorage.getItem(LAST)).toBe('board');
      expect(readView('s2', '/p')).toBe('board');
      expect(readView('s3', '/other')).toBe('board');
    });

    it('writeView without a project leaves project choices alone', () => {
      writeView('s1', 'board', '/p');
      writeView('s2', 'table');
      expect(readView('s3', '/p')).toBe('board');
      expect(readView('s3')).toBe('table');
    });

    it('forgetSessionPrefs clears only the session level', () => {
      writeView('s1', 'board', '/p');
      forgetSessionPrefs('s1');
      expect(window.localStorage.getItem(VIEW + 's1')).toBeNull();
      expect(readView('s1', '/p')).toBe('board');
      expect(window.localStorage.getItem(PROJECT + '/p')).toBe('board');
      expect(window.localStorage.getItem(LAST)).toBe('board');
    });
  });

  describe('layout', () => {
    const split: OrchestratorLayout = {
      split: 'row',
      panes: [
        { view: 'board', size: 0.6 },
        { view: 'transit', size: 0.4 },
      ],
    };

    it('migrates a stored single view into a single-pane layout', () => {
      writeView('s1', 'constellation', '/repo');
      expect(readLayout('s1', '/repo')).toEqual(singlePaneLayout('constellation'));
      // A new session in the same project migrates the project's view the same way.
      expect(readLayout('s2', '/repo')).toEqual(singlePaneLayout('constellation'));
    });

    it('opens on the Tavern alone when nothing is stored', () => {
      expect(readLayout('s1')).toEqual(singlePaneLayout('tavern'));
    });

    it('round-trips a split at the session, project and global levels', () => {
      writeLayout('s1', split, '/repo');
      expect(readLayout('s1', '/repo')).toEqual(split);
      expect(readLayout('s2', '/repo')).toEqual(split);
      expect(readLayout('s3', '/other')).toEqual(split);
    });

    it('keeps session pins at the session level only, stripping them at the project and global levels', () => {
      const pinnedSplit: OrchestratorLayout = {
        ...split,
        panes: [split.panes[0], { ...split.panes[1], sessionId: 'other' }],
      };
      writeLayout('s1', pinnedSplit, '/repo');
      expect(readLayout('s1', '/repo')).toEqual(pinnedSplit);
      expect(readLayout('s2', '/repo')).toEqual(split);
      expect(readLayout('s3', '/elsewhere')).toEqual(split);
      expect(window.localStorage.getItem('b4m.orchestrator.projectLayout./repo')).not.toContain('sessionId');
      expect(window.localStorage.getItem('b4m.orchestrator.lastLayout')).not.toContain('sessionId');
    });

    it("writes the first pane's view as the single view too", () => {
      writeLayout('s1', split, '/repo');
      expect(readView('s1', '/repo')).toBe('board');
    });

    it("prefers the session's layout over its project's, as for views", () => {
      writeLayout('s2', split, '/repo');
      writeLayout('s1', singlePaneLayout('table'), '/repo');
      expect(readLayout('s1', '/repo')).toEqual(singlePaneLayout('table'));
      expect(readLayout('s2')).toEqual(split);
    });

    it('falls back to the single view for a bad saved layout, never throwing', () => {
      writeView('s1', 'transit');
      window.localStorage.setItem('b4m.orchestrator.layout.s1', '{"split":"row","panes":[]}');
      expect(readLayout('s1')).toEqual(singlePaneLayout('transit'));
      window.localStorage.setItem('b4m.orchestrator.layout.s1', 'not json');
      expect(readLayout('s1')).toEqual(singlePaneLayout('transit'));
    });

    it('falls back to the Tavern alone when the layout and view are both unreadable', () => {
      window.localStorage.setItem('b4m.orchestrator.layout.s1', '[]');
      window.localStorage.setItem('b4m.orchestrator.view.s1', 'hologram');
      expect(readLayout('s1')).toEqual(singlePaneLayout('tavern'));
    });

    it('forgetSessionPrefs clears the session layout but not the project one', () => {
      writeLayout('s1', split, '/repo');
      forgetSessionPrefs('s1');
      expect(window.localStorage.getItem('b4m.orchestrator.layout.s1')).toBeNull();
      expect(readLayout('s2', '/repo')).toEqual(split);
    });

    it('yields the default and does not throw when storage throws', () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      expect(() => writeLayout('s1', split, '/repo')).not.toThrow();
      expect(readLayout('s1', '/repo')).toEqual(singlePaneLayout('tavern'));
    });
  });

  it('defaults when nothing is stored', () => {
    expect(readSurface('s1')).toBe('chat');
    expect(readView('s1')).toBe('tavern');
    expect(readView('s1', '/p')).toBe('tavern');
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
      writeView('s1', 'table', '/p');
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

  describe('presenter', () => {
    it('is off until turned on, and remembers both ways', () => {
      expect(readPresenter()).toBe(false);
      writePresenter(true);
      expect(readPresenter()).toBe(true);
      writePresenter(false);
      expect(readPresenter()).toBe(false);
    });
  });
});
