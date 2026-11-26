// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { ORCHESTRATOR_VIEWS } from '../orchestratorViews';
import { ORCHESTRATOR_VIEW_INFO } from '../ViewSwitcher';
import { ORCHESTRATOR_VIEW_COMPONENTS } from '../viewRegistry';
import { SCENE_VIEW_IDS } from './registeredScenes';
import { sceneViewOf } from './SceneStage';
import { parseSceneDefinition } from './sceneDefinition';

// The parity suite (sceneParity.test.tsx) only proves what a scene draws through the framework; this keeps
// every scene on it, and keeps the stage and shell from growing a branch for one scene by id.

// Every renderer source file, keyed by its path from this folder (`../../../` is renderer/src).
const RENDERER_SOURCES = import.meta.glob<string>(
  ['../../../**/*.{ts,tsx}', '!../../../**/*.test.{ts,tsx}', '!../../../**/*.stories.{ts,tsx}'],
  { query: '?raw', import: 'default', eager: true }
);

/**
 * Every `view === '<id>'` or `scene.id === '<id>'` style check (either order, `!==` too) and `case '<id>':`
 * naming one of `ids`.
 */
function sceneIdChecks(source: string, ids: readonly string[]): string[] {
  // Scene ids are kebab names (sceneDefinition.ts), so they need no escaping here.
  const quoted = `['"\`](?:${ids.join('|')})['"\`]`;
  const viewish = String.raw`[\w.?\[\]]*(?:view\w*|\bid)`;
  const patterns = [
    new RegExp(String.raw`${viewish}\s*[!=]==?\s*${quoted}`, 'i'),
    new RegExp(String.raw`${quoted}\s*[!=]==?\s*${viewish}`, 'i'),
    new RegExp(String.raw`\bcase\s+${quoted}\s*:`),
  ];
  return source.split('\n').filter(line => patterns.some(pattern => pattern.test(line)));
}

describe('scene registry', () => {
  it.each(SCENE_VIEW_IDS)('registers "%s" as a framework scene from a valid definition', view => {
    const entry = sceneViewOf(ORCHESTRATOR_VIEW_COMPONENTS[view]);
    if (!entry) return expect.fail(`"${view}" is grouped as a scene but its view is not built by sceneView`);
    const { scene, options } = entry;
    expect(parseSceneDefinition(scene)).toEqual(scene);
    // Test ids and the stage's lookups are keyed by the view id.
    expect(scene.id).toBe(view);
    // A scene cannot switch a framework feature off at registration.
    expect(options).toEqual({});
  });

  it.each(SCENE_VIEW_IDS)('reads the menu and stage info for "%s" off the same definition', view => {
    const scene = sceneViewOf(ORCHESTRATOR_VIEW_COMPONENTS[view])?.scene;
    const info = ORCHESTRATOR_VIEW_INFO[view].scene;
    expect(info).toBeDefined();
    expect(info?.host).toBe(true);
    expect(info?.inSceneDecisions).toBe(true);
    expect(info?.copy).toBe(scene?.copy.stage);
    expect(info?.hostArt).toBe(scene?.cast.host.sprites);
    expect(info?.finale).toBe(scene?.look.finale);
  });

  it('keeps layouts off the scene framework and its stage info', () => {
    for (const view of ORCHESTRATOR_VIEWS.filter(id => !SCENE_VIEW_IDS.includes(id))) {
      expect(sceneViewOf(ORCHESTRATOR_VIEW_COMPONENTS[view]), view).toBeUndefined();
      expect(ORCHESTRATOR_VIEW_INFO[view].scene, view).toBeUndefined();
    }
  });

  it('has no scene-id check anywhere in the renderer: the stage reads capability flags', () => {
    const files = Object.entries(RENDERER_SOURCES);
    expect(files.length, 'the scan found the renderer sources').toBeGreaterThan(100);
    const offenders = files.flatMap(([file, source]) =>
      sceneIdChecks(source, SCENE_VIEW_IDS).map(line => `${file}: ${line.trim()}`)
    );
    expect(offenders).toEqual([]);
  });

  it('catches the forms of a scene-id check it guards against', () => {
    const ids = ['tavern', 'tile-wall'];
    expect(sceneIdChecks("if (view === 'tavern') return;", ids)).toHaveLength(1);
    expect(sceneIdChecks('const x = layout.panes[0].view !== "tavern";', ids)).toHaveLength(1);
    expect(sceneIdChecks("const office = 'tile-wall' === pane.view;", ids)).toHaveLength(1);
    expect(sceneIdChecks("    case 'tavern':", ids)).toHaveLength(1);
    expect(sceneIdChecks("if (scene.id === 'tavern') return;", ids)).toHaveLength(1);
    expect(sceneIdChecks("const isWall = 'tile-wall' !== definition?.id;", ids)).toHaveLength(1);
    expect(sceneIdChecks("singlePaneLayout('tavern')", ids)).toEqual([]);
    expect(sceneIdChecks("lookId === 'tavern'", ids)).toEqual([]);
  });
});
